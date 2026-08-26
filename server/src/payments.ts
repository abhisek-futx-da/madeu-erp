import { many, one, nextDocNumber, type Db } from './db.ts';
import type { Ctx } from './domain.ts';
import { round2, sumBy } from './money.ts';
import { approvalFor, holdVoucher, recordEvent } from './approvals.ts';

/**
 * Receipts and payments. Until this existed a party balance could only grow:
 * the system could invoice a mill's customers and never record that they paid.
 *
 * A receipt debits the bank and credits the customer. A payment does the
 * reverse for a supplier. Allocation against specific invoices is what makes
 * ageing mean anything.
 */

export interface AllocationInput {
  salesInvoiceId?: string | null;
  purchaseInvoiceId?: string | null;
  openingOutstandingId?: string | null;
  amount: number;
}

export type DeductionKind =
  'cash_discount' | 'quality_discount' | 'rate_difference' | 'shortage' | 'tds' | 'other';

export interface DeductionInput {
  salesInvoiceId?: string | null;
  purchaseInvoiceId?: string | null;
  kind: DeductionKind;
  amount: number;
  reason: string;
  taxTreatment?: 'none' | 'credit_note_required' | 'debit_note_required';
}

export interface PaymentInput {
  kind: 'receipt' | 'payment';
  partyId: string;
  paymentDate: string;
  mode: 'cash' | 'cheque' | 'neft' | 'rtgs' | 'upi' | 'adjustment';
  amount: number;
  discount?: number;
  instrumentNo?: string | null;
  instrumentDate?: string | null;
  bankLedgerId?: string | null;
  narration?: string;
  allocations?: AllocationInput[];
  deductions?: DeductionInput[];
}


export async function roleLedgers(db: Db) {
  const rows = await many<{ posting_role: string; id: string }>(
    db, 'select posting_role, id from ledger_account where posting_role is not null'
  );
  return new Map(rows.map(r => [r.posting_role, r.id]));
}

export async function recordPayment(ctx: Ctx, input: PaymentInput) {
  const legacyDiscount = round2(input.discount ?? 0);
  const deductions = input.deductions ?? [];
  const typedDeductions = round2(sumBy(deductions, deduction => deduction.amount));
  const discount = round2(legacyDiscount + typedDeductions);
  const allocations = input.allocations ?? [];
  const allocated = sumBy(allocations, a => a.amount);

  if (allocated > round2(input.amount + discount) + 0.005) {
    throw new Error(
      `allocations (${allocated}) exceed the payment plus discount (${round2(input.amount + discount)})`
    );
  }

  // A receipt settles sales; a payment settles purchases. Mixing them would
  // silently credit the wrong side of the ledger.
  for (const a of allocations) {
    const wrongWay = input.kind === 'receipt' ? a.purchaseInvoiceId : a.salesInvoiceId;
    if (wrongWay) {
      throw new Error(`a ${input.kind} cannot be allocated against that invoice type`);
    }
  }
  const allocatedInvoiceIds = new Set(allocations.map(a =>
    input.kind === 'receipt' ? a.salesInvoiceId : a.purchaseInvoiceId
  ).filter(Boolean));
  for (const deduction of deductions) {
    const target = input.kind === 'receipt'
      ? deduction.salesInvoiceId : deduction.purchaseInvoiceId;
    const wrongWay = input.kind === 'receipt'
      ? deduction.purchaseInvoiceId : deduction.salesInvoiceId;
    if (!target || wrongWay) {
      throw new Error(`a ${input.kind} deduction must name one matching invoice`);
    }
    if (!allocatedInvoiceIds.has(target)) {
      throw new Error('every named deduction must belong to a bill being settled now');
    }
    if (!deduction.reason.trim()) throw new Error('every deduction needs a reason');
  }

  const roles = await roleLedgers(ctx.db);
  // Cash falls back to the cash ledger; anything banked falls back to the
  // account marked default, so a clerk does not have to pick one every time.
  const defaultBank = await one<{ ledger_id: string }>(
    ctx.db, 'select ledger_id from bank_account where is_default limit 1'
  );
  const bankOrCash = input.bankLedgerId
    ?? (input.mode === 'cash' ? roles.get('cash') : (defaultBank?.ledger_id ?? roles.get('bank')));

  if (input.mode !== 'adjustment' && !bankOrCash) {
    throw new Error(
      input.mode === 'cash'
        ? 'no cash ledger is configured'
        : 'no bank account is marked default and none was chosen'
    );
  }

  const series = input.kind === 'receipt' ? 'receipt_voucher' : 'payment_voucher';
  const voucherNo = await nextDocNumber(ctx.db, ctx.tenantId, series, ctx.fy);

  const pay = await one<{ id: string }>(
    ctx.db,
    `insert into payment (tenant_id, voucher_no, kind, payment_date, party_id, mode,
       instrument_no, instrument_date, bank_ledger_id, amount, discount, narration, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [ctx.tenantId, voucherNo, input.kind, input.paymentDate, input.partyId, input.mode,
     input.instrumentNo ?? null, input.instrumentDate ?? null, bankOrCash ?? null,
     round2(input.amount), discount, input.narration ?? '', ctx.userId]
  );
  if (!pay) throw new Error('payment insert returned nothing');

  if (allocations.length > 0) {
    await ctx.db.query(
      `insert into payment_allocation (tenant_id, payment_id, sales_invoice_id,
                                       purchase_invoice_id,opening_outstanding_id,amount)
       select $1, $2, x.si, x.pi, x.oi, x.amt
         from unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::numeric[]) as x(si,pi,oi,amt)`,
      [ctx.tenantId, pay.id,
       allocations.map(a => a.salesInvoiceId ?? null),
       allocations.map(a => a.purchaseInvoiceId ?? null),
       allocations.map(a => a.openingOutstandingId ?? null),
       allocations.map(a => round2(a.amount))]
    );
  }

  if (deductions.length > 0) {
    await ctx.db.query(
      `insert into payment_deduction (tenant_id, payment_id, sales_invoice_id,
                                      purchase_invoice_id, kind, amount, reason, tax_treatment)
       select $1, $2, x.si, x.pi, x.kind::kapat_kind, x.amount, x.reason,
              x.tax_treatment::kapat_tax_treatment
         from unnest($3::uuid[], $4::uuid[], $5::text[], $6::numeric[], $7::text[], $8::text[])
              as x(si,pi,kind,amount,reason,tax_treatment)`,
      [ctx.tenantId, pay.id,
       deductions.map(d => d.salesInvoiceId ?? null),
       deductions.map(d => d.purchaseInvoiceId ?? null),
       deductions.map(d => d.kind), deductions.map(d => round2(d.amount)),
       deductions.map(d => d.reason.trim()),
       deductions.map(d => d.taxTreatment ?? 'none')]
    );
  }

  // Receipt: Dr bank, Dr discount allowed, Cr customer.
  // Payment: Dr supplier, Cr bank, Cr discount received.
  const postings: { ledgerId: string; debit?: number; credit?: number }[] = [];
  const discountRole = input.kind === 'receipt' ? 'discount_allowed' : 'discount_received';
  const discountLedger = roles.get(discountRole);

  const deductionRole = (deduction: DeductionInput) => {
    if (deduction.kind === 'quality_discount') return 'quality_deduction';
    if (deduction.kind === 'rate_difference') return 'rate_difference';
    if (deduction.kind === 'shortage') return 'shortage_claim';
    if (deduction.kind === 'tds') {
      return input.kind === 'receipt' ? 'tds_receivable' : 'tds_payable';
    }
    return discountRole;
  };

  if (input.kind === 'receipt') {
    if (bankOrCash) postings.push({ ledgerId: bankOrCash, debit: round2(input.amount) });
    if (legacyDiscount > 0) {
      if (!discountLedger) throw new Error('no ledger bound to discount_allowed');
      postings.push({ ledgerId: discountLedger, debit: legacyDiscount });
    }
    for (const deduction of deductions) {
      const ledger = roles.get(deductionRole(deduction));
      if (!ledger) throw new Error(`no ledger bound for ${deduction.kind}`);
      postings.push({ ledgerId: ledger, debit: round2(deduction.amount) });
    }
    postings.push({ ledgerId: input.partyId, credit: round2(input.amount + discount) });
  } else {
    postings.push({ ledgerId: input.partyId, debit: round2(input.amount + discount) });
    if (bankOrCash) postings.push({ ledgerId: bankOrCash, credit: round2(input.amount) });
    if (legacyDiscount > 0) {
      if (!discountLedger) throw new Error('no ledger bound to discount_received');
      postings.push({ ledgerId: discountLedger, credit: legacyDiscount });
    }
    for (const deduction of deductions) {
      const ledger = roles.get(deductionRole(deduction));
      if (!ledger) throw new Error(`no ledger bound for ${deduction.kind}`);
      postings.push({ ledgerId: ledger, credit: round2(deduction.amount) });
    }
  }

  const narration = `${input.kind === 'receipt' ? 'Receipt' : 'Payment'} ${voucherNo}` +
    (input.instrumentNo ? ` (${input.mode} ${input.instrumentNo})` : '');
  const voucherType = input.kind === 'receipt' ? 'receipt' : 'payment';

  // Money leaving the business is the entry a mill most wants two people on.
  const approval = await approvalFor(ctx.db, 'payment', input.amount);
  if (approval) {
    await holdVoucher(ctx, 'payment', pay.id, voucherType, input.paymentDate, narration, postings);
    await recordEvent(ctx, 'payment', pay.id, 'submitted', input.amount);
    await ctx.db.query(`update payment set status = 'pending_approval' where id = $1`, [pay.id]);
  } else {
    const voucherId = await postVoucher(
      ctx, voucherType, input.paymentDate, narration, 'payment', pay.id, postings
    );
    await ctx.db.query('update payment set voucher_id = $1 where id = $2', [voucherId, pay.id]);
    if (input.kind === 'receipt') {
      await releaseBrokerageForPayment(ctx, pay.id, input.paymentDate);
    }
  }

  return {
    id: pay.id, voucherNo, kind: input.kind,
    status: approval ? 'pending_approval' : 'approved',
    awaitingApproval: approval ? { role: approval.role, threshold: approval.threshold } : null,
    amount: round2(input.amount), discount, deductions: typedDeductions, allocated,
    taxDocumentsRequired: deductions.filter(d => (d.taxTreatment ?? 'none') !== 'none').length,
    onAccount: round2(input.amount + discount - allocated)
  };
}

/** Suggests the oldest-first allocation a clerk would otherwise do by hand. */
export async function suggestAllocation(ctx: Ctx, partyId: string, kind: 'receipt' | 'payment', amount: number) {
  const view = kind === 'receipt' ? 'v_outstanding_sales' : 'v_outstanding_purchases';
  const idCol = kind === 'receipt' ? 'invoice_id' : 'invoice_id';
  const rows = await many<{
    invoice_id: string; source_kind: 'invoice' | 'opening'; label: string; outstanding: number;
  }>(
    ctx.db,
    `select ${idCol} as invoice_id,source_kind,
            ${kind === 'receipt' ? 'invoice_no' : 'our_ref'} as label,
            outstanding
       from ${view}
      where outstanding > 0.005
        and ${kind === 'receipt' ? 'code' : 'code'} = (select code from ledger_account where id = $1)
      order by invoice_date, created_at`,
    [partyId]
  );

  let left = amount;
  const picks: {
    invoiceId?: string; openingOutstandingId?: string; label: string; amount: number;
  }[] = [];
  for (const r of rows) {
    if (left <= 0.005) break;
    const take = Math.min(left, Number(r.outstanding));
    picks.push({
      ...(r.source_kind === 'opening'
        ? { openingOutstandingId: r.invoice_id }
        : { invoiceId: r.invoice_id }),
      label: r.label, amount: round2(take)
    });
    left = round2(left - take);
  }
  return { allocations: picks, onAccount: round2(left) };
}

export async function cancelPayment(ctx: Ctx, paymentId: string, reason: string) {
  const pay = await one<{ voucher_no: string; status: string; voucher_id: string | null }>(
    ctx.db, 'select voucher_no, status, voucher_id from payment where id = $1', [paymentId]
  );
  if (!pay) throw new Error('payment not found');
  if (pay.status === 'cancelled') throw new Error(`${pay.voucher_no} is already cancelled`);

  await revokeBrokerageForPayment(ctx, paymentId, reason);

  // Reverse rather than delete: the original entry stays visible in the audit.
  if (pay.voucher_id) {
    const lines = await many<{ ledger_id: string; debit: number; credit: number }>(
      ctx.db, 'select ledger_id, debit, credit from voucher_line where voucher_id = $1',
      [pay.voucher_id]
    );
    await postVoucher(
      ctx, 'journal', new Date().toISOString().slice(0, 10),
      `Cancellation of ${pay.voucher_no}: ${reason}`, 'payment', paymentId,
      lines.map(l => ({
        ledgerId: l.ledger_id,
        debit: Number(l.credit) || undefined,
        credit: Number(l.debit) || undefined
      }))
    );
  }

  await ctx.db.query('delete from payment_allocation where payment_id = $1', [paymentId]);
  await ctx.db.query(
    `update payment set status = 'cancelled', narration = narration || ' [cancelled: ' || $2 || ']'
      where id = $1`,
    [paymentId, reason]
  );
  return { voucherNo: pay.voucher_no, cancelled: true };
}

/** Release brokerage only when an approved receipt has cleared the invoice. */
export async function releaseBrokerageForPayment(
  ctx: Ctx, paymentId: string, releaseDate = new Date().toISOString().slice(0, 10)
) {
  const invoices = await many<{
    id: string; invoice_no: string; brokerage_amount: number; broker_id: string;
  }>(ctx.db,
    `select i.id, i.invoice_no, i.brokerage_amount, i.broker_id
       from payment_allocation a
       join payment p on p.id=a.payment_id and p.status='approved' and p.kind='receipt'
       join sales_invoice i on i.id=a.sales_invoice_id and i.brokerage_state='accrued'
       join v_outstanding_sales o on o.invoice_id=i.id and o.outstanding <= 0.005
      where a.payment_id=$1 and i.brokerage_amount > 0
      order by i.id for update of i`, [paymentId]);
  const roles = await roleLedgers(ctx.db);
  const accrued = roles.get('brokerage_accrued');
  if (invoices.length > 0 && !accrued) throw new Error('no ledger bound to brokerage_accrued');
  for (const invoice of invoices) {
    const voucherId = await postVoucher(
      ctx, 'journal', releaseDate,
      `Brokerage payable after settlement of ${invoice.invoice_no}`,
      'brokerage_release', invoice.id,
      [
        { ledgerId: accrued!, debit: round2(invoice.brokerage_amount) },
        { ledgerId: invoice.broker_id, credit: round2(invoice.brokerage_amount) }
      ]
    );
    await ctx.db.query(
      `update sales_invoice set brokerage_state='released', brokerage_released_on=$2,
              brokerage_release_voucher_id=$3, brokerage_release_payment_id=$4
        where id=$1`, [invoice.id, releaseDate, voucherId, paymentId]);
  }
  return { released: invoices.length };
}

/** An owner may forfeit an unpaid bill's accrued commission under the mill's
 * written broker terms. This reverses the expense/accrual; it never deletes or
 * mutates the original invoice voucher. */
export async function forfeitBrokerage(
  ctx: Ctx, invoiceId: string, reason: string,
  forfeitDate = new Date().toISOString().slice(0, 10)
) {
  const invoice = await one<{
    id: string; invoice_no: string; brokerage_amount: number;
  }>(ctx.db,
    `select id,invoice_no,brokerage_amount
       from sales_invoice
      where id=$1 and brokerage_state='accrued' and brokerage_amount>0
        and status in ('approved','partly_done','closed')
      for update`, [invoiceId]);
  if (!invoice) throw new Error('an approved invoice with accrued brokerage was not found');
  const roles = await roleLedgers(ctx.db);
  const accrued = roles.get('brokerage_accrued');
  const expense = roles.get('brokerage_expense');
  if (!accrued || !expense) throw new Error('brokerage accrual and expense ledgers must both be configured');
  const voucherId = await postVoucher(
    ctx, 'journal', forfeitDate,
    `Brokerage forfeited on ${invoice.invoice_no}: ${reason.trim()}`,
    'brokerage_forfeit', invoice.id,
    [
      { ledgerId: accrued, debit: round2(invoice.brokerage_amount) },
      { ledgerId: expense, credit: round2(invoice.brokerage_amount) }
    ]
  );
  await ctx.db.query(
    `update sales_invoice set brokerage_state='forfeited',brokerage_forfeit_voucher_id=$2
      where id=$1`, [invoice.id, voucherId]);
  return { invoiceNo: invoice.invoice_no, state: 'forfeited', voucherId };
}

async function revokeBrokerageForPayment(ctx: Ctx, paymentId: string, reason: string) {
  const invoices = await many<{
    id: string; invoice_no: string; brokerage_release_voucher_id: string;
  }>(ctx.db,
    `select id, invoice_no, brokerage_release_voucher_id
       from sales_invoice
      where brokerage_release_payment_id=$1 and brokerage_state='released'
      order by id for update`, [paymentId]);
  for (const invoice of invoices) {
    const lines = await many<{ ledger_id: string; debit: number; credit: number }>(ctx.db,
      'select ledger_id, debit, credit from voucher_line where voucher_id=$1',
      [invoice.brokerage_release_voucher_id]);
    await postVoucher(
      ctx, 'journal', new Date().toISOString().slice(0, 10),
      `Reverse brokerage release for ${invoice.invoice_no}: ${reason}`,
      'brokerage_release_reversal', invoice.id,
      lines.map(line => ({
        ledgerId: line.ledger_id,
        debit: Number(line.credit) || undefined,
        credit: Number(line.debit) || undefined
      }))
    );
    await ctx.db.query(
      `update sales_invoice set brokerage_state='accrued', brokerage_released_on=null,
              brokerage_release_voucher_id=null, brokerage_release_payment_id=null
        where id=$1`, [invoice.id]);
  }
}

export async function postVoucher(
  ctx: Ctx, type: string, date: string, narration: string,
  sourceDoc: string, sourceId: string,
  postings: { ledgerId: string; debit?: number; credit?: number }[]
) {
  const drift = sumBy(postings, p => (p.debit ?? 0) - (p.credit ?? 0));
  if (Math.abs(drift) > 0.005) {
    throw new Error(`refusing to post an unbalanced ${type} voucher (drift ${drift.toFixed(2)})`);
  }

  const no = await nextDocNumber(ctx.db, ctx.tenantId, `voucher_${type}`, ctx.fy);
  const v = await one<{ id: string }>(
    ctx.db,
    `insert into voucher (tenant_id, voucher_no, voucher_type, voucher_date, narration,
                          source_doc, source_id, is_posted, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,true,$8) returning id`,
    [ctx.tenantId, no, type, date, narration, sourceDoc, sourceId, ctx.userId]
  );
  if (!v) throw new Error('voucher insert returned nothing');

  await ctx.db.query(
    `insert into voucher_line (tenant_id, voucher_id, ledger_id, debit, credit)
     select $1, $2, x.ledger_id, x.debit, x.credit
       from unnest($3::uuid[], $4::numeric[], $5::numeric[]) as x(ledger_id, debit, credit)`,
    [ctx.tenantId, v.id,
     postings.map(p => p.ledgerId),
     postings.map(p => p.debit ?? 0),
     postings.map(p => p.credit ?? 0)]
  );
  return v.id;
}
