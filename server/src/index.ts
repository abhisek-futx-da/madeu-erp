import express from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import { buildRoutes } from './routes.ts';
import { pool } from './db.ts';
import { pruneAuthState } from './auth.ts';

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

/**
 * `origin: true` reflects whatever Origin the caller sends, which with
 * credentials on is a standing invitation. Production must name its front end;
 * only a local dev host is allowed implicitly.
 */
const allowedOrigins = (process.env.CORS_ORIGIN ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);              // curl, server-to-server
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (allowedOrigins.length === 0 && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return cb(null, true);
    }
    cb(new Error(`origin ${origin} is not allowed`));
  },
  credentials: true
}));

app.use(express.json({ limit: '2mb' }));

app.use((_req, res, next) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  if (process.env.FORCE_HTTPS === 'true') {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

/**
 * A blunt per-IP ceiling. Login has its own durable throttle; this is here so
 * one runaway client — or one scraper — cannot exhaust the connection pool.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600);
const hits = new Map<string, { n: number; until: number }>();

app.use((req, res, next) => {
  const now = Date.now();
  const key = req.ip ?? 'unknown';
  const rec = hits.get(key);
  if (!rec || rec.until < now) {
    hits.set(key, { n: 1, until: now + RATE_WINDOW_MS });
  } else if (++rec.n > RATE_MAX) {
    res.setHeader('retry-after', String(Math.ceil((rec.until - now) / 1000)));
    return res.status(429).json({ error: 'too many requests' });
  }
  // Bounded memory: sweep expired buckets rather than holding every IP forever.
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (v.until < now) hits.delete(k);
  }
  next();
});

// One line per request, parseable, no bodies — an ERP logs who did what, not what.
const LOG = process.env.LOG_REQUESTS !== 'false';
app.use((req, res, next) => {
  if (!LOG) return next();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(JSON.stringify({
      t: new Date().toISOString(), method: req.method, path: req.path,
      status: res.statusCode, ms: Math.round(ms),
      user: req.session?.userId ?? null, tenant: req.session?.tenantId ?? null
    }));
  });
  next();
});

app.get('/health', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'select count(*)::int as migrations from schema_migration'
    );
    res.json({ ok: true, migrations: rows[0]?.migrations ?? 0 });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use('/api', buildRoutes());

// An API answers in JSON even when the route does not exist; Express's default
// is an HTML error page, which breaks every client that assumes otherwise.
app.use((req, res) => {
  res.status(404).json({ error: `no such endpoint: ${req.method} ${req.path}` });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'validation failed', issues: err.issues });
    return;
  }
  const e = err as { code?: string; constraint?: string; message?: string };

  // Postgres told us the rule that was broken; pass the rule, not a stack trace.
  const byCode: Record<string, [number, string]> = {
    '23505': [409, `already exists (${e.constraint ?? 'unique constraint'})`],
    '23503': [400, `refers to something that does not exist (${e.constraint ?? 'foreign key'})`],
    '23514': [400, `violates a business rule (${e.constraint ?? 'check constraint'})`],
    '42501': [403, 'not permitted for this tenant'],
    '40P01': [409, 'that record was being changed by someone else; please try again'],
    '40001': [409, 'a concurrent change interfered; please try again'],
    '57014': [504, 'the query took too long and was cancelled']
  };
  const mapped = e.code ? byCode[e.code] : undefined;
  if (mapped) {
    res.status(mapped[0]).json({ error: mapped[1] });
    return;
  }

  /**
   * A thrown business rule is the caller's problem (400); anything else is
   * ours (500). Lumping both into 400 meant no monitor could tell a rejected
   * invoice from a broken server.
   */
  const ours = !(err instanceof Error) || !e.message;
  console.error(JSON.stringify({
    t: new Date().toISOString(), level: ours ? 'error' : 'warn',
    message: e.message ?? String(err),
    stack: ours && err instanceof Error ? err.stack : undefined
  }));
  if (ours) {
    res.status(500).json({ error: 'internal error' });
    return;
  }
  res.status(400).json({ error: e.message });
});

// An idle client killed by the server emits on the pool; unhandled, that took
// the whole process down.
pool.on('error', err => {
  console.error(JSON.stringify({
    t: new Date().toISOString(), level: 'error', message: 'idle client error', detail: String(err)
  }));
});

const port = Number(process.env.PORT ?? 4000);
const server = app.listen(port, () => console.log(`link-erp api listening on :${port}`));

const prune = setInterval(() => {
  pruneAuthState().catch(() => {});
}, 15 * 60_000);
prune.unref();

// In-flight transactions get to finish; a hard kill leaves half a challan posted.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, draining`);
    clearInterval(prune);
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  });
}
