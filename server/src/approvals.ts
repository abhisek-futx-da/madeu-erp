import { many, one, nextDocNumber, type Db } from './db.ts';
import type { Ctx } from './domain.ts';
import { round2, sumBy } from './money.ts';

/**
 * Maker–checker. A document worth more than the tenant's threshold is created
 * but not posted: its voucher lines are held, and a *different* person holding
 * the required role releases them.
 *
 * The rule that matters is that the maker can never be the checker. Everything
 * else — thresholds, which role approves — is configuration.
 */

export type ApprovableDoc = 'sales_invoice' | 'purchase_invoice' | 'payment' | 'stock_count'
  | 'grey_return' | 'dyeing_return' | 'customer_return' | 'write_off';

export interface Posting { ledgerId: string; debit?: number; credit?: number }

interface Rule { min_amount: number; approver_role: string }

/**
 * Whether this document needs a second signature, and from whom. Absent or
 * inactive rule means no approval — a mill that has not asked for this should
 * not suddenly find its invoices held.
 */
export async function approvalFor(
  db: Db, docType: ApprovableDoc, amount: number
): Promise<{ role: string; threshold: number } | null> {
  const rule = await one<Rule>(
    db,
    `select min_amount, approver_role from approval_rule
      where doc_type = $1 and is_active`,
    [docType]
  );
  if (!rule) return null;
  if (round2(amount) < Number(rule.min_amount)) return null;
  return { role: rule.approver_role, threshold: Number(rule.min_amount) };
}

/**
 * Holds a voucher instead of posting it. Returns the held id so the caller can
 * record it against the document.
 */
export async function holdVoucher(
  ctx: Ctx, docType: ApprovableDoc, docId: string,
  voucherType: string, voucherDate: string, narration: string, postings: Posting[]
) {
  const drift = sumBy(postings, p => (p.debit ?? 0) - (p.credit ?? 0));
  if (Math.abs(drift) > 0.005) {
    throw new Error(`refusing to hold an unbalanced ${voucherType} voucher (drift ${drift})`);
  }

  const held = await one<{ id: string }>(
    ctx.db,
    `insert into deferred_voucher (tenant_id, doc_type, doc_id, voucher_type,
                                   voucher_date, narration)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [ctx.tenantId, docType, docId, voucherType, voucherDate, narration]
  );
  if (!held) throw new Error('deferred voucher insert returned nothing');

  await ctx.db.query(
    `insert into deferred_voucher_line (tenant_id, deferred_id, ledger_id, debit, credit)
     select $1, $2, x.ledger_id, x.debit, x.credit
       from unnest($3::uuid[], $4::numeric[], $5::numeric[]) as x(ledger_id, debit, credit)`,
    [ctx.tenantId, held.id,
     postings.map(p => p.ledgerId),
     postings.map(p => round2(p.debit ?? 0)),
     postings.map(p => round2(p.credit ?? 0))]
  );

  return held.id;
}

export async function recordEvent(
  ctx: Ctx, docType: ApprovableDoc, docId: string,
  action: 'submitted' | 'approved' | 'rejected' | 'cancelled', amount: number | null, note = ''
) {
  await ctx.db.query(
    `insert into approval_event (tenant_id, doc_type, doc_id, action, amount, actor_id, note)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [ctx.tenantId, docType, docId, action, amount === null ? null : round2(amount), ctx.userId, note]
  );
}

/** A cancellation belongs in the same immutable decision history as approval
 * and rejection.  Its amount is intentionally null: the original document,
 * voucher reversal, and any held-voucher deletion remain the monetary record. */
export async function recordCancellation(
  ctx: Ctx, docType: ApprovableDoc, docId: string, reason: string
) {
  await recordEvent(ctx, docType, docId, 'cancelled', null, reason);
}

const TABLE: Record<ApprovableDoc, { table: string; noColumn: string; amount: string }> = {
  sales_invoice:    { table: 'sales_invoice',    noColumn: 'invoice_no',  amount: 'invoice_total' },
  purchase_invoice: { table: 'purchase_invoice', noColumn: 'our_ref',     amount: 'invoice_total' },
  payment:          { table: 'payment',          noColumn: 'voucher_no',  amount: 'amount' },
  stock_count:      { table: 'stock_count',      noColumn: 'count_no',    amount: 'net_value' },
  grey_return:      { table: 'grey_return',      noColumn: 'entry_no',    amount: 'amount' },
  dyeing_return:    { table: 'dyeing_return',    noColumn: 'entry_no',    amount: 'amount' },
  customer_return:  { table: 'customer_return',  noColumn: 'entry_no',    amount: 'amount' },
  write_off:        { table: 'write_off',        noColumn: 'entry_no',    amount: 'amount' }
};

/**
 * Releases a held document. The approver's role must match the rule, and the
 * approver must not be the person who raised it — which is the entire point of
 * the exercise and so is checked here rather than trusted to the interface.
 */
export async function approveDocument(
  ctx: Ctx & { role: string }, docType: ApprovableDoc, docId: string, note = '',
  /**
   * Work the document owes the world beyond its voucher — a stock count moves
   * pieces as well as rupees. Passed in by the caller rather than looked up
   * here, so this module stays ignorant of what it is approving.
   */
  afterPost?: (ctx: Ctx & { role: string }) => Promise<void>
) {
  const spec = TABLE[docType];

  // Lock the document: two approvers clicking together must not post twice.
  const doc = await one<{ doc_no: string; status: string; amount: number; created_by: string }>(
    ctx.db,
    `select ${spec.noColumn} as doc_no, status, ${spec.amount} as amount, created_by
       from ${spec.table} where id = $1 for update`,
    [docId]
  );
  if (!doc) throw new Error(`${docType} not found`);
  if (doc.status !== 'pending_approval') {
    throw new Error(`${doc.doc_no} is ${doc.status}, not awaiting approval`);
  }

  const rule = await approvalFor(ctx.db, docType, Number(doc.amount));
  const required = rule?.role ?? 'owner';
  if (ctx.role !== required && ctx.role !== 'owner') {
    throw new Error(`${doc.doc_no} needs the ${required} role to approve; you hold ${ctx.role}`);
  }
  if (doc.created_by === ctx.userId) {
    throw new Error(
      `${doc.doc_no} was raised by you; approval needs a second person`
    );
  }

  const held = await one<{ id: string; voucher_type: string; voucher_date: string; narration: string }>(
    ctx.db,
    `select id, voucher_type, voucher_date::text, narration from deferred_voucher
      where doc_type = $1 and doc_id = $2 and posted_as is null`,
    [docType, docId]
  );
  // A stock count that found nothing wrong is still a document worth
  // approving, and it has no entry to make. Anything with a value must.
  if (!held) {
    if (round2(Number(doc.amount)) !== 0) throw new Error(`no held voucher for ${doc.doc_no}`);
    await ctx.db.query(`update ${spec.table} set status = 'approved' where id = $1`, [docId]);
    await recordEvent(ctx, docType, docId, 'approved', 0, note);
    if (afterPost) await afterPost(ctx);
    return { docType, docId, docNo: doc.doc_no, status: 'approved', voucherNo: null, amount: 0 };
  }

  const lines = await many<{ ledger_id: string; debit: number; credit: number }>(
    ctx.db,
    'select ledger_id, debit, credit from deferred_voucher_line where deferred_id = $1',
    [held.id]
  );

  const voucherNo = await nextDocNumber(
    ctx.db, ctx.tenantId, `voucher_${held.voucher_type}`, ctx.fy
  );
  const v = await one<{ id: string }>(
    ctx.db,
    `insert into voucher (tenant_id, voucher_no, voucher_type, voucher_date, narration,
                          source_doc, source_id, is_posted, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,true,$8) returning id`,
    [ctx.tenantId, voucherNo, held.voucher_type, held.voucher_date,
     `${held.narration} [approved]`, docType, docId, ctx.userId]
  );
  if (!v) throw new Error('voucher insert returned nothing');

  await ctx.db.query(
    `insert into voucher_line (tenant_id, voucher_id, ledger_id, debit, credit)
     select $1, $2, x.ledger_id, x.debit, x.credit
       from unnest($3::uuid[], $4::numeric[], $5::numeric[]) as x(ledger_id, debit, credit)`,
    [ctx.tenantId, v.id,
     lines.map(l => l.ledger_id),
     lines.map(l => Number(l.debit)),
     lines.map(l => Number(l.credit))]
  );

  await ctx.db.query('update deferred_voucher set posted_as = $1 where id = $2', [v.id, held.id]);
  await ctx.db.query(
    `update ${spec.table} set status = 'approved', voucher_id = $2 where id = $1`,
    [docId, v.id]
  );
  await recordEvent(ctx, docType, docId, 'approved', Number(doc.amount), note);

  // Last, so a stock movement that the guard refuses takes the voucher down
  // with it rather than leaving the books ahead of the floor.
  if (afterPost) await afterPost(ctx);

  return {
    docType, docId, docNo: doc.doc_no, status: 'approved',
    voucherNo, amount: round2(Number(doc.amount))
  };
}

/**
 * Refuses a held document. The held voucher is dropped rather than posted, so
 * a rejected invoice never touches the ledger at all.
 */
export async function rejectDocument(
  ctx: Ctx & { role: string }, docType: ApprovableDoc, docId: string, reason: string
) {
  const spec = TABLE[docType];
  const doc = await one<{ doc_no: string; status: string; amount: number; created_by: string }>(
    ctx.db,
    `select ${spec.noColumn} as doc_no, status, ${spec.amount} as amount, created_by
       from ${spec.table} where id = $1 for update`,
    [docId]
  );
  if (!doc) throw new Error(`${docType} not found`);
  if (doc.status !== 'pending_approval') {
    throw new Error(`${doc.doc_no} is ${doc.status}, not awaiting approval`);
  }

  const rule = await approvalFor(ctx.db, docType, Number(doc.amount));
  const required = rule?.role ?? 'owner';
  if (ctx.role !== required && ctx.role !== 'owner') {
    throw new Error(`${doc.doc_no} needs the ${required} role to reject; you hold ${ctx.role}`);
  }

  await ctx.db.query(
    'delete from deferred_voucher where doc_type = $1 and doc_id = $2 and posted_as is null',
    [docType, docId]
  );
  await ctx.db.query(`update ${spec.table} set status = 'rejected' where id = $1`, [docId]);
  await recordEvent(ctx, docType, docId, 'rejected', Number(doc.amount), reason);

  return { docType, docId, docNo: doc.doc_no, status: 'rejected', reason };
}
