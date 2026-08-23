import { one, withoutTenant } from './db.ts';

/**
 * Atomically consumes one request from a shared, fixed-window bucket.
 * Returns the number of seconds to wait when the ceiling is exceeded.
 */
export async function consumeRateLimit(
  key: string,
  max: number,
  windowMs = 60_000
): Promise<number | null> {
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('rate-limit maximum must be a positive integer');
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error('rate-limit window must be positive');

  return withoutTenant(async db => {
    const row = await one<{ hits: number; retry_after: number }>(
      db,
      `insert into api_rate_limit (bucket_key, window_started_at, hits)
       values ($1, clock_timestamp(), 1)
       on conflict (bucket_key) do update
         set hits = case
               when api_rate_limit.window_started_at <=
                    clock_timestamp() - ($2::int * interval '1 millisecond')
                 then 1
               else api_rate_limit.hits + 1
             end,
             window_started_at = case
               when api_rate_limit.window_started_at <=
                    clock_timestamp() - ($2::int * interval '1 millisecond')
                 then clock_timestamp()
               else api_rate_limit.window_started_at
             end
       returning hits,
         greatest(1, ceil(extract(epoch from
           (window_started_at + ($2::int * interval '1 millisecond') - clock_timestamp())
         )))::int as retry_after`,
      [key, windowMs]
    );
    if (!row || row.hits <= max) return null;
    return Number(row.retry_after);
  });
}

export async function pruneRateLimits(retainMs = 24 * 60 * 60_000): Promise<void> {
  await withoutTenant(db => db.query(
    `delete from api_rate_limit
      where window_started_at < clock_timestamp() - ($1::int * interval '1 millisecond')`,
    [retainMs]
  ));
}
