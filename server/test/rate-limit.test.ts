import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.ts';
import { consumeRateLimit } from '../src/rate-limit.ts';

after(async () => { await pool.end(); });

test('the shared rate limiter is atomic and survives process boundaries', async () => {
  const key = `test:${crypto.randomUUID()}`;
  assert.equal(await consumeRateLimit(key, 2, 60_000), null);
  assert.equal(await consumeRateLimit(key, 2, 60_000), null);
  const retry = await consumeRateLimit(key, 2, 60_000);
  assert.ok(retry !== null && retry > 0 && retry <= 60);
});
