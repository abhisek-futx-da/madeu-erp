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

function followingFyLabel(label: string) {
  const start = Number(label.slice(0, 4)) + 1;
  return `${start}-${String(start + 1).slice(-2)}`;
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
    `select starts_on::text, ends_on::text, status
       from financial_year where label = $1 for update`,
    [label]
  );
  if (!fy) throw new Error(`financial year ${label} does not exist`);
  if (fy.status === 'closed') throw new Error(`financial year ${label} is already closed`);
  if (fy.status !== 'open') throw new Error(`financial year ${label} is ${fy.status}`);
  const expectedNext = followingFyLabel(label);
  if (nextLabel !== expectedNext) {
    throw new Error(`the year after ${label} must be ${expectedNext}`);
  }

  await ctx.db.query(
    `insert into financial_year (tenant_id, label, starts_on, ends_on, status)
     values ($1, $2, ($3::date + 1), ($3::date + interval '1 year')::date, 'open')
     on conflict (tenant_id, label) do nothing`,
    [ctx.tenantId, nextLabel, fy.ends_on]
  );
  const nextFy = await one<{ starts_on: string; ends_on: string; status: string }>(
    ctx.db,
    `select starts_on::text, ends_on::text, status
       from financial_year where label = $1 for update`,
    [nextLabel]
  );
  if (!nextFy || nextFy.starts_on !== addDays(fy.ends_on, 1)
      || nextFy.ends_on !== addYears(fy.ends_on, 1)) {
    throw new Error(`${nextLabel} is not the consecutive financial year after ${label}`);
  }
  if (nextFy.status === 'pending') {
    await ctx.db.query(
      `update financial_year set status='open' where label=$1`, [nextLabel]
    );
    nextFy.status = 'open';
  }
  if (nextFy.status !== 'open') {
    throw new Error(`next financial year ${nextLabel} is ${nextFy.status}`);
  }

  await ctx.db.query(
    `insert into document_series (tenant_id, doc_type, fy_label, prefix, next_number)
     select tenant_id, doc_type, $1, replace(prefix, $2, $3), 1
       from document_series where fy_label = $4
     on conflict (tenant_id, doc_type, fy_label) do nothing`,
    [nextLabel, label.slice(2), nextLabel.slice(2), label]
  );

  const invalidOpening = await one<{ ledger: string }>(
    ctx.db,
    `select la.name as ledger
       from opening_balance ob
       join ledger_account la on la.id = ob.ledger_id
       join control_account ca on ca.id = la.control_account_id
      where ob.fy_label = $1
        and ca.nature in ('income', 'expense')
        and abs(ob.debit - ob.credit) > 0.005
      limit 1`,
    [label]
  );
  if (invalidOpening) {
    throw new Error(`income or expense ledger ${invalidOpening.ledger} cannot carry an opening balance`);
  }

  const balances = await many<{ ledger_id: string; balance: number; nature: string }>(
    ctx.db,
    `select x.ledger_id, sum(x.balance) as balance, ca.nature
       from (
         select ob.ledger_id, ob.debit - ob.credit as balance
           from opening_balance ob
          where ob.fy_label = $3
         union all
         select vl.ledger_id, vl.debit - vl.credit as balance
           from voucher_line vl
           join voucher v on v.id = vl.voucher_id and v.is_posted
          where v.voucher_date between $1 and $2
       ) x
       join ledger_account la on la.id = x.ledger_id
       join control_account ca on ca.id = la.control_account_id
      group by x.ledger_id, ca.nature`,
    [fy.starts_on, fy.ends_on, label]
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

  const next = await one<{ starts_on: string }>(
    ctx.db, 'select starts_on::text from financial_year where label = $1', [nextLabel]
  );
  if (!next) throw new Error(`next financial year ${nextLabel} does not exist`);
  const posted = await one<{ n: number }>(
    ctx.db,
    `select count(*)::int as n from voucher
      where is_posted and voucher_date >= $1`,
    [next.starts_on]
  );
  if ((posted?.n ?? 0) > 0) {
    throw new Error(`cannot reopen ${label}: ${nextLabel} already contains posted vouchers`);
  }

  await ctx.db.query('delete from opening_balance where fy_label = $1', [nextLabel]);
  await ctx.db.query(
    `update financial_year set status='pending' where label=$1`, [nextLabel]
  );
  await ctx.db.query(
    `update financial_year set status = 'open', closed_at = null, closed_by = null
      where label = $1`,
    [label]
  );
  return { fyLabel: label, status: 'open' as const };
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addYears(date: string, years: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}
