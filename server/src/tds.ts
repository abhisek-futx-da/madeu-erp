import { many, one, type Db } from './db.ts';
import type { Ctx } from './domain.ts';
import { round2, sumBy } from './money.ts';

/**
 * TDS. Two threshold rules exist and they behave differently:
 *  - `excess_over_threshold` (194Q): charge only the part above the threshold
 *  - `full_once_crossed` (194C): once crossed, charge the whole amount
 * Both are cumulative per party per section per financial year, so what was
 * already deducted has to be read before deciding what to deduct now.
 */

export interface Section {
  code: string;
  kind: 'tds' | 'tcs';
  rate: number;
  rate_no_pan: number;
  threshold: number;
  basis: 'excess_over_threshold' | 'full_once_crossed';
}

export interface Deduction {
  sectionCode: string;
  kind: 'tds' | 'tcs';
  baseAmount: number;
  chargeable: number;
  rate: number;
  amount: number;
}


/**
 * What to deduct on `amount`, given what this party has already crossed.
 * Pure, so the arithmetic is testable without a database.
 */
export function computeDeduction(
  section: Section,
  priorBase: number,
  amount: number,
  hasPan: boolean
): Deduction | null {
  const rate = hasPan ? section.rate : section.rate_no_pan;
  const totalAfter = priorBase + amount;

  let chargeable: number;
  if (section.basis === 'excess_over_threshold') {
    // Only the slice of this document that sits above the threshold.
    const alreadyAbove = Math.max(0, priorBase - section.threshold);
    const nowAbove = Math.max(0, totalAfter - section.threshold);
    chargeable = nowAbove - alreadyAbove;
  } else {
    if (totalAfter < section.threshold) return null;
    // The document that crosses the line carries everything up to that point.
    chargeable = priorBase >= section.threshold ? amount : totalAfter;
  }

  chargeable = round2(chargeable);
  if (chargeable <= 0) return null;

  return {
    sectionCode: section.code,
    kind: section.kind,
    baseAmount: round2(amount),
    chargeable,
    rate,
    amount: round2((chargeable * rate) / 100)
  };
}

/** Resolves the section for a party and reads their running total in one pass. */
export async function deductionFor(
  ctx: Ctx, partyId: string, amount: number
): Promise<Deduction | null> {
  const row = await one<{
    code: string; kind: 'tds' | 'tcs'; rate: number; rate_no_pan: number;
    threshold: number; basis: Section['basis']; pan: string | null; prior_base: number;
  }>(
    ctx.db,
    `select s.code, s.kind, s.rate, s.rate_no_pan, s.threshold, s.basis, la.pan,
            coalesce((select sum(d.base_amount) from tax_deduction d
                       where d.party_id = la.id and d.section_code = s.code
                         and d.fy_label = $2), 0) as prior_base
       from ledger_account la
       join tax_deduction_section s
         on s.tenant_id = la.tenant_id and s.code = la.tds_section
      where la.id = $1`,
    [partyId, ctx.fy]
  );
  if (!row) return null;

  return computeDeduction(
    {
      code: row.code, kind: row.kind, rate: Number(row.rate),
      rate_no_pan: Number(row.rate_no_pan), threshold: Number(row.threshold), basis: row.basis
    },
    Number(row.prior_base),
    amount,
    !!row.pan
  );
}

/**
 * Records the deduction and posts it. TDS reduces what we owe the supplier:
 * debit the party, credit TDS payable. The purchase voucher already credited
 * the party the gross, so this leaves the net payable.
 */
export async function recordDeduction(
  ctx: Ctx,
  d: Deduction,
  party: { id: string },
  doc: { type: string; id: string; date: string }
) {
  const tdsPayable = await one<{ id: string }>(
    ctx.db, `select id from ledger_account where code = '940'`
  );
  if (!tdsPayable) throw new Error('no TDS Payable ledger (code 940) is configured');

  const voucher = await one<{ id: string }>(
    ctx.db,
    `insert into voucher (tenant_id, voucher_no, voucher_type, voucher_date, narration,
                          source_doc, source_id, is_posted, created_by)
     values ($1,
             (select coalesce(prefix,'') || next_number from document_series
               where tenant_id = $1 and doc_type = 'voucher_journal' and fy_label = $2),
             'journal', $3, $4, $5, $6, true, $7)
     returning id`,
    [ctx.tenantId, ctx.fy, doc.date,
     `TDS ${d.sectionCode} @ ${d.rate}% on ${doc.type}`, doc.type, doc.id, ctx.userId]
  );
  if (!voucher) throw new Error('TDS voucher insert returned nothing');
  await ctx.db.query(
    `update document_series set next_number = next_number + 1
      where tenant_id = $1 and doc_type = 'voucher_journal' and fy_label = $2`,
    [ctx.tenantId, ctx.fy]
  );

  await ctx.db.query(
    `insert into voucher_line (tenant_id, voucher_id, ledger_id, debit, credit)
     values ($1,$2,$3,$4,0), ($1,$2,$5,0,$4)`,
    [ctx.tenantId, voucher.id, party.id, d.amount, tdsPayable.id]
  );

  await ctx.db.query(
    `insert into tax_deduction (tenant_id, section_code, kind, party_id, doc_type, doc_id,
       doc_date, fy_label, base_amount, chargeable, rate, amount, voucher_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [ctx.tenantId, d.sectionCode, d.kind, party.id, doc.type, doc.id, doc.date, ctx.fy,
     d.baseAmount, d.chargeable, d.rate, d.amount, voucher.id]
  );

  return { ...d, voucherId: voucher.id };
}

// ------------------------------------------------------------ year close --

export interface CloseResult {
  fyLabel: string;
  nextFy: string;
  ledgersCarried: number;
  totalDebit: number;
  totalCredit: number;
}

/**
 * Closes a financial year: proves the books balance, carries every balance
 * sheet account forward as an opening balance, then locks the year so nothing
 * can be posted into it again.
 */
export async function closeFinancialYear(
  ctx: Ctx, label: string, nextLabel: string
): Promise<CloseResult> {
  const fy = await one<{ starts_on: string; ends_on: string; status: string }>(
    ctx.db,
    'select starts_on::text, ends_on::text, status from financial_year where label = $1',
    [label]
  );
  if (!fy) throw new Error(`financial year ${label} does not exist`);
  if (fy.status === 'closed') throw new Error(`financial year ${label} is already closed`);

  const balances = await many<{ ledger_id: string; balance: number; nature: string }>(
    ctx.db,
    `select vl.ledger_id, sum(vl.debit - vl.credit) as balance, ca.nature
       from voucher_line vl
       join voucher v on v.id = vl.voucher_id and v.is_posted
       join ledger_account la on la.id = vl.ledger_id
       join control_account ca on ca.id = la.control_account_id
      where v.voucher_date between $1 and $2
      group by vl.ledger_id, ca.nature`,
    [fy.starts_on, fy.ends_on]
  );

  const drift = sumBy(balances, b => Number(b.balance));
  if (Math.abs(drift) > 0.01) {
    throw new Error(`refusing to close ${label}: the books are out by ${drift.toFixed(2)}`);
  }

  // Income and expense close to the profit and loss; only balance sheet
  // accounts carry an opening balance into the next year. Their net result is
  // transferred to retained earnings, which is what makes the two sides agree.
  const PL = new Set(['income', 'expense']);
  const carried = balances.filter(b => !PL.has(b.nature) && Math.abs(Number(b.balance)) > 0.005);

  const plResult = round2(
    sumBy(balances.filter(b => PL.has(b.nature)), b => Number(b.balance))
  );
  if (Math.abs(plResult) > 0.005) {
    const retained = await one<{ id: string }>(
      ctx.db, `select id from ledger_account where posting_role = 'retained_earnings'`
    );
    if (!retained) {
      throw new Error('no ledger is bound to the posting role "retained_earnings"');
    }
    // A loss is a debit to retained earnings; a profit is a credit.
    carried.push({ ledger_id: retained.id, balance: plResult, nature: 'capital' });
  }

  if (carried.length > 0) {
    await ctx.db.query(
      `insert into opening_balance (tenant_id, fy_label, ledger_id, debit, credit)
       select $1, $2, x.ledger_id,
              case when x.balance > 0 then x.balance else 0 end,
              case when x.balance < 0 then -x.balance else 0 end
         from unnest($3::uuid[], $4::numeric[]) as x(ledger_id, balance)
       on conflict (tenant_id, fy_label, ledger_id) do update
         set debit = excluded.debit, credit = excluded.credit`,
      [ctx.tenantId, nextLabel, carried.map(c => c.ledger_id), carried.map(c => Number(c.balance))]
    );
  }

  await ctx.db.query(
    `update financial_year set status = 'closed', closed_at = now(), closed_by = $1
      where label = $2`,
    [ctx.userId, label]
  );

  return {
    fyLabel: label,
    nextFy: nextLabel,
    ledgersCarried: carried.length,
    totalDebit: sumBy(carried.filter(c => Number(c.balance) > 0), c => Number(c.balance)),
    totalCredit: -sumBy(carried.filter(c => Number(c.balance) < 0), c => Number(c.balance))
  };
}

/**
 * Reopens a closed year. Restricted to the owner and audited by the fact that
 * every voucher already carries its own trail — a mill occasionally has to
 * reopen after an auditor finds something, and pretending otherwise just means
 * somebody edits the database by hand.
 */
export async function reopenFinancialYear(ctx: Ctx, label: string, nextLabel: string) {
  const fy = await one<{ status: string }>(
    ctx.db, 'select status from financial_year where label = $1', [label]
  );
  if (!fy) throw new Error(`financial year ${label} does not exist`);
  if (fy.status !== 'closed') throw new Error(`financial year ${label} is not closed`);

  await ctx.db.query('delete from opening_balance where fy_label = $1', [nextLabel]);
  await ctx.db.query(
    `update financial_year set status = 'open', closed_at = null, closed_by = null
      where label = $1`,
    [label]
  );
  return { fyLabel: label, status: 'open' as const };
}
