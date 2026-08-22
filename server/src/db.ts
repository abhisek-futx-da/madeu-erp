import pg from 'pg';

// numeric/int8 arrive as strings by default; the API speaks numbers.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);
pg.types.setTypeParser(pg.types.builtins.INT8, Number);
// A DATE is a calendar date. Parsing it into a JS Date shifts it by the local
// UTC offset, so 2026-09-10 comes back as the 9th anywhere east of Greenwich.
pg.types.setTypeParser(pg.types.builtins.DATE, (v: string) => v);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
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
