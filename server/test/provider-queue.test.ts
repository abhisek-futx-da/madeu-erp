/**
 * The statutory submission queue.
 *
 * These are unit tests against a real database and a fake "provider" that is
 * just a function. That is the point: the machinery around a portal call —
 * idempotency, bounded retry, kept history — is exactly the part that can be
 * proven without a credential, and it is the part that decides whether an
 * ambiguous timeout registers an invoice twice.
 *
 * Nothing here demonstrates that any government portal accepts anything. See
 * docs/GSP_IRP_READINESS.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withTenant, one, many } from '../src/db.ts';
import {
  enqueue, claimDue, runOne, retrySubmission, cancelSubmission, releaseStale,
  idempotencyKey, type AttemptOutcome
} from '../src/provider-queue.ts';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = 'aaaaaaaa-0000-0000-0000-000000000001';
const stamp = Date.now();

const ctxFor = <T>(fn: (ctx: { db: any; tenantId: string; userId: string }) => Promise<T>) =>
  withTenant(TENANT, USER, db => fn({ db, tenantId: TENANT, userId: USER }));

/** A document id that is unique per test but need not exist: the queue is generic. */
const docId = (n: number) => `00000000-0000-4000-8000-${String(stamp % 1e12).padStart(12, '0')}`
  .slice(0, 24) + String(n).padStart(12, '0').slice(0, 12);

const succeeds = async (): Promise<AttemptOutcome> => ({ ok: true, code: 'ACCEPTED' });
const failsRetryably = async (): Promise<AttemptOutcome> =>
  ({ ok: false, code: 'IRP_DOWN', message: 'gateway timeout', httpStatus: 504, retryable: true });
const failsPermanently = async (): Promise<AttemptOutcome> =>
  ({ ok: false, code: '2150', message: 'duplicate IRN for the document', retryable: false });

// -------------------------------------------------------------- idempotency --

test('the key is derived from the document, not invented', () => {
  assert.equal(
    idempotencyKey('einvoice', 'generate', 'sales_invoice', 'abc'),
    idempotencyKey('einvoice', 'generate', 'sales_invoice', 'abc')
  );
  assert.notEqual(
    idempotencyKey('einvoice', 'generate', 'sales_invoice', 'abc'),
    idempotencyKey('eway', 'generate', 'sales_invoice', 'abc')
  );
});

test('queueing the same document twice is the same submission', async () => {
  const id = docId(1);
  const first = await ctxFor(ctx => enqueue(ctx, {
    channel: 'einvoice', docType: 'sales_invoice', docId: id
  }));
  const second = await ctxFor(ctx => enqueue(ctx, {
    channel: 'einvoice', docType: 'sales_invoice', docId: id
  }));

  assert.equal(second.id, first.id, 'a second press created a second submission');
  assert.equal(first.alreadyQueued, false);
  assert.equal(second.alreadyQueued, true);
});

test('two workers pressing at once still produce one submission', async () => {
  const id = docId(2);
  const [a, b] = await Promise.all([
    ctxFor(ctx => enqueue(ctx, { channel: 'einvoice', docType: 'sales_invoice', docId: id })),
    ctxFor(ctx => enqueue(ctx, { channel: 'einvoice', docType: 'sales_invoice', docId: id }))
  ]);
  assert.equal(a.id, b.id);

  const rows = await ctxFor(ctx => many(
    ctx.db, 'select id from provider_submission where doc_id = $1', [id]
  ));
  assert.equal(rows.length, 1);
});

// -------------------------------------------------------------------- happy --

test('a successful attempt is recorded and the submission closes', async () => {
  const id = docId(3);
  const s = await ctxFor(ctx => enqueue(ctx, {
    channel: 'einvoice', docType: 'sales_invoice', docId: id
  }));
  const out = await ctxFor(ctx => runOne(ctx, { id: s.id, attempts: 0 }, succeeds));
  assert.equal(out.state, 'succeeded');

  const row = await ctxFor(ctx => one<{ state: string; attempts: number; succeeded_at: string }>(
    ctx.db, 'select state, attempts, succeeded_at from provider_submission where id = $1', [s.id]
  ));
  assert.equal(row!.state, 'succeeded');
  assert.equal(row!.attempts, 1);
  assert.ok(row!.succeeded_at);

  const attempts = await ctxFor(ctx => many<{ outcome: string; code: string }>(
    ctx.db, 'select outcome, code from provider_attempt where submission_id = $1', [s.id]
  ));
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.outcome, 'succeeded');
});

// ------------------------------------------------------------------ failure --

test('a retryable failure backs off rather than hammering the portal', async () => {
  const id = docId(4);
  const s = await ctxFor(ctx => enqueue(ctx, {
    channel: 'einvoice', docType: 'sales_invoice', docId: id
  }));

  const first = await ctxFor(ctx => runOne(ctx, { id: s.id, attempts: 0 }, failsRetryably));
  assert.equal(first.state, 'failed');
  assert.equal(first.retryInSeconds, 30);

  const second = await ctxFor(ctx => runOne(ctx, { id: s.id, attempts: 1 }, failsRetryably));
  assert.equal(second.state, 'failed');
  assert.ok(second.retryInSeconds! > first.retryInSeconds!, 'the backoff did not grow');

  const row = await ctxFor(ctx => one<{ last_code: string; last_error: string }>(
    ctx.db, 'select last_code, last_error from provider_submission where id = $1', [s.id]
  ));
  assert.equal(row!.last_code, 'IRP_DOWN');
  assert.match(row!.last_error, /gateway timeout/);
});

test('a rejection the portal will repeat is abandoned at once', async () => {
  const id = docId(5);
  const s = await ctxFor(ctx => enqueue(ctx, {
    channel: 'einvoice', docType: 'sales_invoice', docId: id
  }));
  const out = await ctxFor(ctx => runOne(ctx, { id: s.id, attempts: 0 }, failsPermanently));

  assert.equal(out.state, 'abandoned');
  assert.equal(out.reason, 'the portal will not accept it');
  // One attempt, not five: asking the same malformed question again is noise.
  const attempts = await ctxFor(ctx => many(
    ctx.db, 'select 1 from provider_attempt where submission_id = $1', [s.id]
  ));
  assert.equal(attempts.length, 1);
});

test('retrying is bounded, and every try is kept', async () => {
  const id = docId(6);
  const s = await ctxFor(ctx => enqueue(ctx, {
    channel: 'einvoice', docType: 'sales_invoice', docId: id, maxAttempts: 3
  }));

  const states: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await ctxFor(ctx => runOne(ctx, { id: s.id, attempts: attempt }, failsRetryably));
    states.push(out.state);
  }
  assert.deepEqual(states, ['failed', 'failed', 'abandoned']);

  const attempts = await ctxFor(ctx => many<{ attempt_no: number; code: string }>(
    ctx.db,
    'select attempt_no, code from provider_attempt where submission_id = $1 order by attempt_no',
    [s.id]
  ));
  assert.deepEqual(attempts.map(a => a.attempt_no), [1, 2, 3]);
});

test('an exception in the provider call is a failed attempt, never a lost one', async () => {
  const id = docId(7);
  const s = await ctxFor(ctx => enqueue(ctx, {
    channel: 'einvoice', docType: 'sales_invoice', docId: id
  }));
  const out = await ctxFor(ctx => runOne(ctx, { id: s.id, attempts: 0 }, async () => {
    throw new Error('socket hang up');
  }));

  assert.equal(out.state, 'failed');
  const row = await ctxFor(ctx => one<{ last_code: string; last_error: string }>(
    ctx.db, 'select last_code, last_error from provider_submission where id = $1', [s.id]
  ));
  assert.equal(row!.last_code, 'EXCEPTION');
  assert.match(row!.last_error, /socket hang up/);
});

test('the attempt history cannot be rewritten', async () => {
  const id = docId(8);
  const s = await ctxFor(ctx => enqueue(ctx, {
    channel: 'einvoice', docType: 'sales_invoice', docId: id
  }));
  await ctxFor(ctx => runOne(ctx, { id: s.id, attempts: 0 }, failsRetryably));

  await ctxFor(ctx => ctx.db.query(
    `update provider_attempt set message = 'nothing happened' where submission_id = $1`, [s.id]
  ));
  await ctxFor(ctx => ctx.db.query(
    'delete from provider_attempt where submission_id = $1', [s.id]
  ));

  const attempts = await ctxFor(ctx => many<{ message: string }>(
    ctx.db, 'select message from provider_attempt where submission_id = $1', [s.id]
  ));
  assert.equal(attempts.length, 1);
  assert.match(attempts[0]!.message, /gateway timeout/);
});

// -------------------------------------------------------------- the operator --

test('an operator can put an abandoned submission back, and the history survives', async () => {
  const id = docId(9);
  const s = await ctxFor(ctx => enqueue(ctx, {
    channel: 'einvoice', docType: 'sales_invoice', docId: id, maxAttempts: 1
  }));
  await ctxFor(ctx => runOne(ctx, { id: s.id, attempts: 0 }, failsRetryably));

  const back = await ctxFor(ctx => retrySubmission(ctx, s.id));
  assert.equal(back.state, 'queued');

  const row = await ctxFor(ctx => one<{ state: string; attempts: number }>(
    ctx.db, 'select state, attempts from provider_submission where id = $1', [s.id]
  ));
  assert.equal(row!.attempts, 0, 'the operator decision did not reset the count');

  const attempts = await ctxFor(ctx => many(
    ctx.db, 'select 1 from provider_attempt where submission_id = $1', [s.id]
  ));
  assert.equal(attempts.length, 1, 'the earlier failure was erased');
});

test('a succeeded submission cannot be retried or cancelled', async () => {
  const id = docId(10);
  const s = await ctxFor(ctx => enqueue(ctx, {
    channel: 'einvoice', docType: 'sales_invoice', docId: id
  }));
  await ctxFor(ctx => runOne(ctx, { id: s.id, attempts: 0 }, succeeds));

  await assert.rejects(
    () => ctxFor(ctx => retrySubmission(ctx, s.id)), /already succeeded/
  );
  await assert.rejects(
    () => ctxFor(ctx => cancelSubmission(ctx, s.id, 'no')), /already succeeded/
  );
});

test('cancelling records who gave up and why', async () => {
  const id = docId(11);
  const s = await ctxFor(ctx => enqueue(ctx, {
    channel: 'einvoice', docType: 'sales_invoice', docId: id
  }));
  const out = await ctxFor(ctx => cancelSubmission(ctx, s.id, 'invoice is being cancelled'));
  assert.equal(out.state, 'cancelled');

  const row = await ctxFor(ctx => one<{ state: string; last_error: string }>(
    ctx.db, 'select state, last_error from provider_submission where id = $1', [s.id]
  ));
  assert.equal(row!.state, 'cancelled');
  assert.match(row!.last_error, /being cancelled/);
});

// ------------------------------------------------------------------ workers --

test('due work is claimed once, even by two workers at the same moment', async () => {
  const id = docId(12);
  await ctxFor(ctx => enqueue(ctx, { channel: 'eway', docType: 'dispatch', docId: id }));

  const [a, b] = await Promise.all([
    ctxFor(ctx => claimDue(ctx, 50)),
    ctxFor(ctx => claimDue(ctx, 50))
  ]);
  const claimed = [...a, ...b].filter(r => r.doc_id === id);
  assert.equal(claimed.length, 1, 'the same submission was claimed twice');
});

test('a submission that is not due yet is not claimed', async () => {
  const id = docId(13);
  const s = await ctxFor(ctx => enqueue(ctx, {
    channel: 'einvoice', docType: 'sales_invoice', docId: id
  }));
  await ctxFor(ctx => runOne(ctx, { id: s.id, attempts: 0 }, failsRetryably));

  const due = await ctxFor(ctx => claimDue(ctx, 100));
  assert.ok(!due.some(r => r.id === s.id), 'a backed-off submission was claimed early');
});

test('work claimed by a worker that died is released, not stranded', async () => {
  const id = docId(14);
  const s = await ctxFor(ctx => enqueue(ctx, {
    channel: 'einvoice', docType: 'sales_invoice', docId: id
  }));
  await ctxFor(ctx => claimDue(ctx, 100));
  await ctxFor(ctx => ctx.db.query(
    `update provider_submission set claimed_at = now() - interval '2 hours' where id = $1`, [s.id]
  ));

  const released = await ctxFor(ctx => releaseStale(ctx, 15));
  assert.ok(released >= 1);

  const row = await ctxFor(ctx => one<{ state: string; last_code: string }>(
    ctx.db, 'select state, last_code from provider_submission where id = $1', [s.id]
  ));
  assert.equal(row!.state, 'failed');
  assert.equal(row!.last_code, 'STALLED');
});
