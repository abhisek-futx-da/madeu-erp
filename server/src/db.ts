import pg from 'pg';

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.(\d+))?$/;

/**
 * The JSON API speaks numbers, but PostgreSQL deliberately returns NUMERIC as
 * text because an arbitrary decimal may not survive IEEE-754. Every NUMERIC in
 * this schema has a bounded scale; accept it only when its scaled integer is
 * still inside JavaScript's exact-integer range. A future migration that
 * widens a value past that contract now fails loudly instead of corrupting a
 * ledger silently.
 */
export function parsePgNumeric(value: string): number {
  const match = DECIMAL.exec(value);
  if (!match) throw new Error(`invalid PostgreSQL numeric: ${value}`);
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const scaled = BigInt(unsigned.replace('.', ''));
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`PostgreSQL numeric exceeds the exact API boundary: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`PostgreSQL numeric is not finite: ${value}`);
  return parsed;
}

export function parsePgInt8(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`PostgreSQL int8 exceeds the exact API boundary: ${value}`);
  }
  return parsed;
}

pg.types.setTypeParser(pg.types.builtins.NUMERIC, parsePgNumeric);
pg.types.setTypeParser(pg.types.builtins.INT8, parsePgInt8);
// A DATE is a calendar date. Parsing it into a JS Date shifts it by the local
// UTC offset, so 2026-09-10 comes back as the 9th anywhere east of Greenwich.
pg.types.setTypeParser(pg.types.builtins.DATE, (v: string) => v);

// Production passes discrete PG* values so an arbitrary strong password does
// not have to be URL-encoded into a connection string. Tests may still use a
// Unix-socket DATABASE_URL for their disposable database.
export const pool = new pg.Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX ?? 10) }
  : {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT ?? 5432),
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      max: Number(process.env.PG_POOL_MAX ?? 10)
    });

export type Db = pg.PoolClient;

/**
 * Runs `fn` in one transaction with app.tenant_id set, which is what every RLS
 * policy reads. Nothing tenant-scoped may be queried outside this wrapper.
 */
export async function withTenant<T>(
  tenantId: string,
  userId: string | null,
  fn: (db: Db) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    if (userId) await client.query('select set_config($1, $2, true)', ['app.user_id', userId]);
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The same transaction plus `app.party_id`, which every `v_portal_*` view
 * narrows on. The party comes from the verified session and never from the
 * request: an outside login that could name its own party could read the whole
 * godown. When the setting is absent those views match nothing, so the failure
 * mode is an empty portal rather than somebody else's goods.
 */
export async function withParty<T>(
  tenantId: string,
  partyId: string,
  userId: string | null,
  fn: (db: Db) => Promise<T>
): Promise<T> {
  return withTenant(tenantId, userId, async db => {
    await db.query('select set_config($1, $2, true)', ['app.party_id', partyId]);
    return fn(db);
  });
}

/** Auth only: reaches app_user, which is deliberately not tenant-scoped. */
export async function withoutTenant<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function one<T>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const { rows } = await db.query(sql, params);
  return (rows[0] as T | undefined) ?? null;
}

export async function many<T>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await db.query(sql, params);
  return rows as T[];
}

/** Per-FY series, locked so two concurrent saves cannot take the same number. */
export async function nextDocNumber(db: Db, tenantId: string, docType: string, fy: string) {
  const row = await one<{ prefix: string; next_number: number }>(
    db,
    `insert into document_series (tenant_id, doc_type, fy_label, next_number)
     values ($1, $2, $3, 2)
     on conflict (tenant_id, doc_type, fy_label)
       do update set next_number = document_series.next_number + 1
     returning prefix, document_series.next_number - 1 as next_number`,
    [tenantId, docType, fy]
  );
  if (!row) throw new Error(`could not allocate a ${docType} number`);
  return `${row.prefix}${row.next_number}`;
}
