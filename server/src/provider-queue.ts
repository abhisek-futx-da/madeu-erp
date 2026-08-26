import { many, one, type Db } from './db.ts';

/**
 * The machinery around a statutory submission: idempotency, bounded retry with
 * backoff, and a kept history of every attempt.
 *
 * Deliberately ignorant of what it is submitting. It takes a function that
 * performs one attempt and reports success or a coded failure; whether that
 * function talks to an IRP, an e-way portal or a fake in a test is not this
 * module's business. That is what makes it testable without a credential —
 * and it is also why nothing in this file may ever be read as evidence that a
 * government portal accepted anything.
 */

export type SubmissionState =
  'queued' | 'in_flight' | 'succeeded' | 'failed' | 'abandoned' | 'cancelled';

export interface AttemptOutcome {
  ok: boolean;
  code?: string;
  message?: string;
  httpStatus?: number;
  /** False for a rejection the portal will repeat: retrying it wastes a quota. */
  retryable?: boolean;
}

export interface Ctx { db: Db; tenantId: string; userId: string }

/**
 * Backoff in seconds, by attempt. Deliberately a small fixed table rather than
 * an unbounded formula: a mill wants to know that a stuck invoice is looked at
 * again within the hour, not that it doubles forever.
 */
const BACKOFF_SECONDS = [30, 120, 600, 1800, 3600];

/** `attempt` is 1-based: the first failure waits the first interval, not the second. */
const backoffFor = (attempt: number) =>
  BACKOFF_SECONDS[Math.min(Math.max(attempt, 1) - 1, BACKOFF_SECONDS.length - 1)]!;

/**
 * One submission per document per channel and action. The key is derived, so
 * pressing the button twice after an ambiguous timeout asks about the same
 * submission instead of registering the invoice twice.
 */
export const idempotencyKey = (channel: string, action: string, docType: string, docId: string) =>
  `${channel}:${action}:${docType}:${docId}`;

export async function enqueue(
  ctx: Ctx,
  input: { channel: string; action?: string; docType: string; docId: string; maxAttempts?: number }
) {
  const action = input.action ?? 'generate';
  const key = idempotencyKey(input.channel, action, input.docType, input.docId);

  const row = await one<{ id: string; state: SubmissionState; attempts: number; existed: boolean }>(
    ctx.db,
    `insert into provider_submission (tenant_id, channel, action, doc_type, doc_id,
                                      idempotency_key, max_attempts, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (tenant_id, idempotency_key) do update
       -- Touching the row rather than doing nothing lets the caller read back
       -- the existing state: DO NOTHING returns no row at all.
       set channel = excluded.channel
     returning id, state, attempts, (xmax <> 0) as existed`,
    [ctx.tenantId, input.channel, action, input.docType, input.docId, key,
     input.maxAttempts ?? 5, ctx.userId]
  );
  if (!row) throw new Error('could not queue the submission');
  return { id: row.id, state: row.state, attempts: row.attempts, alreadyQueued: row.existed };
}

/**
 * Claims work that is due. `skip locked` is what makes two workers safe: each
 * takes different rows rather than blocking on the same one.
 */
export async function claimDue(ctx: Ctx, limit = 10) {
  return many<{
    id: string; channel: string; action: string; doc_type: string; doc_id: string;
    attempts: number; max_attempts: number;
  }>(
    ctx.db,
    `update provider_submission s
        set state = 'in_flight', claimed_at = now()
      where s.id in (
        select id from provider_submission
         where tenant_id = $1
           and state in ('queued', 'failed')
           and next_attempt_at <= now()
         order by next_attempt_at
         limit $2
         for update skip locked
      )
      returning s.id, s.channel, s.action, s.doc_type, s.doc_id, s.attempts, s.max_attempts`,
    [ctx.tenantId, limit]
  );
}

/**
 * Records what happened and decides what happens next. A non-retryable
 * rejection is abandoned immediately: asking a portal the same malformed
 * question five times is not resilience, it is noise.
 */
export async function recordAttempt(
  ctx: Ctx,
  submissionId: string,
  attemptNo: number,
  outcome: AttemptOutcome,
  startedAt: Date
) {
  await ctx.db.query(
    `insert into provider_attempt (tenant_id, submission_id, attempt_no, started_at,
                                   finished_at, outcome, code, message, http_status)
     values ($1,$2,$3,$4,now(),$5,$6,$7,$8)`,
    [ctx.tenantId, submissionId, attemptNo, startedAt,
     outcome.ok ? 'succeeded' : 'failed',
     outcome.code ?? null, outcome.message ?? null, outcome.httpStatus ?? null]
  );

  if (outcome.ok) {
    await ctx.db.query(
      `update provider_submission
          set state = 'succeeded', attempts = $2, succeeded_at = now(),
              last_code = null, last_error = null
        where id = $1`,
      [submissionId, attemptNo]
    );
    return { state: 'succeeded' as const };
  }

  const row = await one<{ max_attempts: number }>(
    ctx.db, 'select max_attempts from provider_submission where id = $1', [submissionId]
  );
  const exhausted = attemptNo >= (row?.max_attempts ?? 5);
  const giveUp = exhausted || outcome.retryable === false;

  await ctx.db.query(
    `update provider_submission
        set state = $2::submission_state, attempts = $3,
            last_code = $4, last_error = $5,
            next_attempt_at = case when $2 = 'failed'
                                   then now() + ($6::int * interval '1 second')
                                   else next_attempt_at end
      where id = $1`,
    [submissionId, giveUp ? 'abandoned' : 'failed', attemptNo,
     outcome.code ?? null, outcome.message ?? null, backoffFor(attemptNo)]
  );

  return {
    state: giveUp ? ('abandoned' as const) : ('failed' as const),
    retryInSeconds: giveUp ? null : backoffFor(attemptNo),
    reason: exhausted ? 'out of attempts' : outcome.retryable === false ? 'the portal will not accept it' : null
  };
}

/** Runs one submission through `perform`, whatever `perform` happens to be. */
export async function runOne(
  ctx: Ctx,
  submission: { id: string; attempts: number },
  perform: () => Promise<AttemptOutcome>
) {
  const attemptNo = submission.attempts + 1;
  const startedAt = new Date();
  let outcome: AttemptOutcome;
  try {
    outcome = await perform();
  } catch (err) {
    // A thrown error is a failed attempt, not a lost one. Losing the record is
    // how a submission ends up in_flight forever with nobody able to say why.
    outcome = {
      ok: false, code: 'EXCEPTION',
      message: err instanceof Error ? err.message : String(err),
      retryable: true
    };
  }
  return recordAttempt(ctx, submission.id, attemptNo, outcome, startedAt);
}

/**
 * Puts an abandoned submission back in the queue. An operator decision, so it
 * resets the attempt count — and the history of why it was abandoned survives,
 * because attempts are append-only.
 */
export async function retrySubmission(ctx: Ctx, submissionId: string) {
  const row = await one<{ state: SubmissionState; doc_type: string }>(
    ctx.db,
    'select state, doc_type from provider_submission where id = $1 for update',
    [submissionId]
  );
  if (!row) throw new Error('no such submission');
  if (row.state === 'succeeded') throw new Error('that submission already succeeded');
  if (row.state === 'in_flight') throw new Error('that submission is being tried right now');

  await ctx.db.query(
    `update provider_submission
        set state = 'queued', attempts = 0, next_attempt_at = now(),
            last_code = null, last_error = null
      where id = $1`,
    [submissionId]
  );
  return { submissionId, state: 'queued' as const };
}

export async function cancelSubmission(ctx: Ctx, submissionId: string, reason: string) {
  const row = await one<{ state: SubmissionState }>(
    ctx.db, 'select state from provider_submission where id = $1 for update', [submissionId]
  );
  if (!row) throw new Error('no such submission');
  if (row.state === 'succeeded') {
    throw new Error('that submission already succeeded; cancel the document instead');
  }
  await ctx.db.query(
    `update provider_submission
        set state = 'cancelled', last_code = 'CANCELLED', last_error = $2
      where id = $1`,
    [submissionId, reason]
  );
  return { submissionId, state: 'cancelled' as const, reason };
}

/**
 * A submission claimed by a worker that then died stays `in_flight` forever.
 * Anything claimed longer ago than this is put back; it is safe because the
 * work is idempotent.
 */
export async function releaseStale(ctx: Ctx, olderThanMinutes = 15) {
  const rows = await many<{ id: string }>(
    ctx.db,
    `update provider_submission
        set state = 'failed',
            last_code = 'STALLED',
            last_error = 'a worker claimed this and did not report back',
            next_attempt_at = now()
      where tenant_id = $1 and state = 'in_flight'
        and claimed_at < now() - ($2::int * interval '1 minute')
      returning id`,
    [ctx.tenantId, olderThanMinutes]
  );
  return rows.length;
}
