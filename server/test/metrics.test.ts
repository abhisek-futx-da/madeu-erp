/**
 * Metrics.
 *
 * The numbers here say how much work a mill has waiting and how far behind it
 * is, which is commercial information about somebody's business. Most of these
 * tests are therefore about who may read them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const TOKEN = process.env.METRICS_TOKEN ?? 'test-only-metrics-token';

const scrape = (token?: string) =>
  fetch(`${BASE}/metrics`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });

test('metrics are refused without the monitoring token', async () => {
  const r = await scrape();
  assert.equal(r.status, 401);
});

test('a wrong token is refused, and a nearly-right one too', async () => {
  for (const wrong of ['nope', TOKEN.slice(0, -1), `${TOKEN}x`]) {
    const r = await scrape(wrong);
    assert.equal(r.status, 401, `"${wrong}" was accepted`);
  }
});

test('the monitor gets Prometheus text, not JSON', async () => {
  const r = await scrape(TOKEN);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /text\/plain/);

  const body = await r.text();
  assert.match(body, /^link_erp_up 1$/m);
  assert.match(body, /^# TYPE link_erp_up gauge$/m);
  assert.match(body, /link_erp_uptime_seconds \d+/);
});

test('every request is counted, whatever the outcome', async () => {
  const before = await (await scrape(TOKEN)).text();
  const counted = (body: string) =>
    [...body.matchAll(/^link_erp_requests_total\{[^}]*\} (\d+)$/gm)]
      .reduce((n, m) => n + Number(m[1]), 0);

  await fetch(`${BASE}/api/does-not-exist`);
  await fetch(`${BASE}/health`);

  const after = await (await scrape(TOKEN)).text();
  assert.ok(counted(after) > counted(before), 'the counter did not move');
  // Status class, never the path: a crawler must not create a series per URL.
  assert.match(after, /link_erp_requests_total\{method="GET",status="\dxx"\}/);
  assert.ok(!/status="404"/.test(after), 'a bare status code leaked into a label');
});

test('the database is reported reachable, with the backlogs a mill cares about', async () => {
  const body = await (await scrape(TOKEN)).text();
  assert.match(body, /^link_erp_database_reachable 1$/m);
  for (const kind of [
    'approvals_pending', 'declarations_unanswered', 'challans_unacknowledged',
    'jobwork_over_a_year', 'einvoice_backlog', 'stock_counts_open'
  ]) {
    assert.match(body, new RegExp(`link_erp_backlog\\{kind="${kind}"\\} \\d+`), `${kind} missing`);
  }
});

test('the connection pool is visible, which is what saturation looks like', async () => {
  const body = await (await scrape(TOKEN)).text();
  for (const state of ['total', 'idle', 'waiting']) {
    assert.match(body, new RegExp(`link_erp_db_pool\\{state="${state}"\\} \\d+`));
  }
});

test('scraping is not rate limited: a monitor must still reach an overloaded API', async () => {
  const many = await Promise.all(Array.from({ length: 30 }, () => scrape(TOKEN)));
  assert.ok(many.every(r => r.status === 200), 'a scrape was throttled');
});
