import { pool, withoutTenant, many } from './db.ts';

/**
 * Metrics, in Prometheus text format, with no client library.
 *
 * Hand-rolled for two reasons. A monitoring dependency is a production
 * dependency, and the dependency audit in CI is there precisely to keep that
 * list short. More importantly, the numbers worth waking someone for here are
 * not request rates — they are business backlogs. An ERP that answers every
 * request in nine milliseconds while forty thaans have sat unacknowledged at a
 * dyeing house for three weeks is not healthy, and no generic exporter knows
 * that.
 */

interface Bucket { count: number; totalMs: number }

const requests = new Map<string, Bucket>();
/** Bounded: a scanner hitting unknown paths must not grow this without limit. */
const MAX_SERIES = 500;

export function observeRequest(method: string, status: number, ms: number) {
  // Status class rather than code, and no path: a per-path series explodes the
  // moment anything crawls the API, and the class is what an alert reads.
  const key = `${method}|${Math.floor(status / 100)}xx`;
  const bucket = requests.get(key);
  if (bucket) {
    bucket.count += 1;
    bucket.totalMs += ms;
  } else if (requests.size < MAX_SERIES) {
    requests.set(key, { count: 1, totalMs: ms });
  }
}

const escape = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function line(name: string, value: number, labels: Record<string, string> = {}) {
  const tags = Object.entries(labels)
    .map(([k, v]) => `${k}="${escape(v)}"`).join(',');
  return `${name}${tags ? `{${tags}}` : ''} ${Number.isFinite(value) ? value : 0}`;
}

/**
 * Installation-wide, through a security-definer function. Asking these
 * questions under row-level security produced a confident zero on a fresh
 * connection and an error on a pooled one — a gauge that reads zero when it
 * means "I could not look" is worse than no gauge at all.
 */
const BACKLOG_SQL = 'select * from operator_backlog()';

export async function renderMetrics(): Promise<string> {
  const out: string[] = [];

  out.push('# HELP link_erp_up 1 when the process is serving.');
  out.push('# TYPE link_erp_up gauge');
  out.push(line('link_erp_up', 1));

  out.push('# HELP link_erp_uptime_seconds Seconds since this process started.');
  out.push('# TYPE link_erp_uptime_seconds gauge');
  out.push(line('link_erp_uptime_seconds', Math.round(process.uptime())));

  out.push('# HELP link_erp_requests_total Requests handled, by method and status class.');
  out.push('# TYPE link_erp_requests_total counter');
  out.push('# HELP link_erp_request_duration_ms_total Milliseconds spent handling them.');
  out.push('# TYPE link_erp_request_duration_ms_total counter');
  for (const [key, bucket] of requests) {
    const [method, status] = key.split('|') as [string, string];
    out.push(line('link_erp_requests_total', bucket.count, { method, status }));
    out.push(line('link_erp_request_duration_ms_total', Math.round(bucket.totalMs), { method, status }));
  }

  out.push('# HELP link_erp_db_pool Connections in the pool, by state.');
  out.push('# TYPE link_erp_db_pool gauge');
  out.push(line('link_erp_db_pool', pool.totalCount, { state: 'total' }));
  out.push(line('link_erp_db_pool', pool.idleCount, { state: 'idle' }));
  out.push(line('link_erp_db_pool', pool.waitingCount, { state: 'waiting' }));

  // A database that cannot answer is the alert; it must not take the scrape
  // down with it, or the monitor loses every other number at the same moment.
  let backlog: Record<string, number> | null = null;
  try {
    const rows = await withoutTenant(db => many<Record<string, number>>(db, BACKLOG_SQL));
    backlog = rows[0] ?? null;
  } catch {
    backlog = null;
  }

  out.push('# HELP link_erp_database_reachable 1 when the backlog query answered.');
  out.push('# TYPE link_erp_database_reachable gauge');
  out.push(line('link_erp_database_reachable', backlog ? 1 : 0));

  if (backlog) {
    out.push('# HELP link_erp_backlog Work waiting on a person, by kind.');
    out.push('# TYPE link_erp_backlog gauge');
    for (const [kind, value] of Object.entries(backlog)) {
      out.push(line('link_erp_backlog', Number(value), { kind }));
    }
  }

  return out.join('\n') + '\n';
}
