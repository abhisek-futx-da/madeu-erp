import { many, one } from './db.ts';
import type { Ctx } from './domain.ts';
import { round2, sumBy } from './money.ts';

export interface StatementLineInput {
  txnDate: string;
  valueDate?: string | null;
  reference?: string | null;
  description?: string;
  /** Money into the account is positive; money out is negative. */
  amount: number;
}

export interface ReconciliationInput {
  bankAccountId: string;
  statementFrom: string;
  statementTo: string;
  openingBalance: number;
  closingBalance: number;
  lines: StatementLineInput[];
}

interface ReconciliationRow {
  id: string; bank_account_id: string; ledger_id: string; bank_name: string; account_no: string;
  statement_from: string; statement_to: string; opening_balance: number; closing_balance: number;
  status: 'draft' | 'completed' | 'cancelled'; created_by: string; created_at: string;
  maker_name: string; completed_at: string | null; checker_name: string | null;
}

async function lockedReconciliation(ctx: Ctx, id: string) {
  return one<ReconciliationRow>(ctx.db,
    `select r.*, b.ledger_id, b.bank_name, b.account_no,
            maker.full_name as maker_name, r.completed_at, checker.full_name as checker_name
       from bank_reconciliation r
       join bank_account b on b.id = r.bank_account_id
       join app_user maker on maker.id = r.created_by
       left join app_user checker on checker.id = r.completed_by
      where r.id = $1
      for update of r`, [id]);
}

export async function listReconciliations(ctx: Ctx) {
  return many(ctx.db,
    `select r.id, r.statement_from, r.statement_to, r.opening_balance, r.closing_balance,
            r.status, r.created_at, r.completed_at, b.bank_name, b.account_no,
            maker.full_name as maker_name, checker.full_name as checker_name,
            count(l.id)::int as statement_lines,
            count(l.matched_payment_id)::int as matched_lines
       from bank_reconciliation r
       join bank_account b on b.id = r.bank_account_id
       join app_user maker on maker.id = r.created_by
       left join app_user checker on checker.id = r.completed_by
       left join bank_statement_line l on l.reconciliation_id = r.id
      group by r.id, b.bank_name, b.account_no, maker.full_name, checker.full_name
      order by r.statement_to desc, r.created_at desc`);
}

export async function createReconciliation(ctx: Ctx, input: ReconciliationInput) {
  if (input.statementTo < input.statementFrom) throw new Error('statement end precedes its start');
  if (input.lines.length === 0) throw new Error('a bank statement needs at least one transaction');
  for (const [index, line] of input.lines.entries()) {
    if (line.txnDate < input.statementFrom || line.txnDate > input.statementTo) {
      throw new Error(`statement line ${index + 1} is outside the selected period`);
    }
    if (Math.abs(round2(line.amount)) < 0.005) throw new Error(`statement line ${index + 1} has no amount`);
  }
  const expectedClosing = round2(input.openingBalance + sumBy(input.lines, line => line.amount));
  if (expectedClosing !== round2(input.closingBalance)) {
    throw new Error(
      `statement does not add up: opening plus transactions is ${expectedClosing.toFixed(2)}, ` +
      `not ${round2(input.closingBalance).toFixed(2)}`
    );
  }

  const bank = await one<{ id: string }>(ctx.db,
    'select id from bank_account where id = $1', [input.bankAccountId]);
  if (!bank) throw new Error('bank account not found');

  const reconciliation = await one<{ id: string }>(ctx.db,
    `insert into bank_reconciliation
       (tenant_id, bank_account_id, statement_from, statement_to,
        opening_balance, closing_balance, created_by)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [ctx.tenantId, input.bankAccountId, input.statementFrom, input.statementTo,
     round2(input.openingBalance), round2(input.closingBalance), ctx.userId]);
  if (!reconciliation) throw new Error('bank reconciliation insert returned nothing');

  await ctx.db.query(
    `insert into bank_statement_line
       (tenant_id, reconciliation_id, sequence_no, txn_date, value_date, reference, description, amount)
     select $1, $2, x.seq, x.txn_date, x.value_date, x.reference, x.description, x.amount
       from unnest($3::integer[], $4::date[], $5::date[], $6::text[], $7::text[], $8::numeric[])
         as x(seq, txn_date, value_date, reference, description, amount)`,
    [ctx.tenantId, reconciliation.id,
     input.lines.map((_, i) => i + 1), input.lines.map(l => l.txnDate),
     input.lines.map(l => l.valueDate ?? null), input.lines.map(l => l.reference ?? null),
     input.lines.map(l => l.description ?? ''), input.lines.map(l => round2(l.amount))]
  );
  return { id: reconciliation.id, lines: input.lines.length, expectedClosing };
}

async function balanceSummary(ctx: Ctx, reconciliation: ReconciliationRow) {
  const fy = await one<{ label: string; starts_on: string }>(ctx.db,
    `select label, starts_on from financial_year
      where $1::date between starts_on and ends_on`, [reconciliation.statement_to]);
  if (!fy) throw new Error(`no financial year contains ${reconciliation.statement_to}`);

  const opening = await one<{ balance: number }>(ctx.db,
    `select coalesce(sum(debit - credit), 0) as balance
       from opening_balance where fy_label = $1 and ledger_id = $2`,
    [fy.label, reconciliation.ledger_id]);
  const movement = await one<{ balance: number }>(ctx.db,
    `select coalesce(sum(vl.debit - vl.credit), 0) as balance
       from voucher_line vl join voucher v on v.id = vl.voucher_id
      where vl.ledger_id = $1 and v.is_posted
        and v.voucher_date between $2 and $3`,
    [reconciliation.ledger_id, fy.starts_on, reconciliation.statement_to]);
  const unmatched = await one<{ balance: number; count: number }>(ctx.db,
    `select coalesce(sum(case p.kind when 'receipt' then p.amount else -p.amount end), 0) as balance,
            count(*)::int as count
       from payment p
      where p.bank_ledger_id = $1 and p.status = 'approved'
        and p.payment_date <= $2 and p.reconciled_at is null`,
    [reconciliation.ledger_id, reconciliation.statement_to]);
  const statement = await one<{ total: number; count: number; matched: number }>(ctx.db,
    `select coalesce(sum(amount), 0) as total, count(*)::int as count,
            count(matched_payment_id)::int as matched
       from bank_statement_line where reconciliation_id = $1`, [reconciliation.id]);

  const bookClosing = round2(Number(opening?.balance ?? 0) + Number(movement?.balance ?? 0));
  const unmatchedBook = round2(Number(unmatched?.balance ?? 0));
  const adjustedStatement = round2(Number(reconciliation.closing_balance) + unmatchedBook);
  return {
    statementTotal: round2(Number(statement?.total ?? 0)),
    statementLines: Number(statement?.count ?? 0), matchedLines: Number(statement?.matched ?? 0),
    statementArithmeticDifference: round2(
      Number(reconciliation.opening_balance) + Number(statement?.total ?? 0) - Number(reconciliation.closing_balance)
    ),
    bookClosing, unmatchedBook, unmatchedBookCount: Number(unmatched?.count ?? 0),
    adjustedStatement, difference: round2(bookClosing - adjustedStatement)
  };
}

export async function getReconciliation(ctx: Ctx, id: string) {
  const reconciliation = await lockedReconciliation(ctx, id);
  if (!reconciliation) throw new Error('bank reconciliation not found');
  const lines = await many(ctx.db,
      `select l.*, p.voucher_no as matched_voucher_no, party.name as matched_party,
              case p.kind when 'receipt' then p.amount else -p.amount end as matched_amount
         from bank_statement_line l
         left join payment p on p.id = l.matched_payment_id
         left join ledger_account party on party.id = p.party_id
        where l.reconciliation_id = $1 order by l.sequence_no`, [id]);
  const candidates = await many(ctx.db,
      `select p.id, p.voucher_no, p.payment_date, p.kind, p.mode, p.instrument_no,
              p.narration, party.name as party_name,
              case p.kind when 'receipt' then p.amount else -p.amount end as amount
         from payment p join ledger_account party on party.id = p.party_id
        where p.bank_ledger_id = $1 and p.status = 'approved' and p.reconciled_at is null
          and p.payment_date between ($2::date - 45) and ($3::date + 45)
        order by p.payment_date, p.voucher_no`,
      [reconciliation.ledger_id, reconciliation.statement_from, reconciliation.statement_to]);
  const summary = await balanceSummary(ctx, reconciliation);
  return { reconciliation, lines, candidates, summary };
}

export async function matchStatementLine(ctx: Ctx, reconciliationId: string, lineId: string, paymentId: string) {
  const reconciliation = await lockedReconciliation(ctx, reconciliationId);
  if (!reconciliation) throw new Error('bank reconciliation not found');
  if (reconciliation.status !== 'draft') throw new Error('only a draft reconciliation can be changed');
  const line = await one<{ amount: number; matched_payment_id: string | null }>(ctx.db,
    `select amount, matched_payment_id from bank_statement_line
      where id = $1 and reconciliation_id = $2 for update`, [lineId, reconciliationId]);
  if (!line) throw new Error('bank statement line not found');
  if (line.matched_payment_id) throw new Error('bank statement line is already matched');

  const payment = await one<{ amount: number; kind: 'receipt' | 'payment'; status: string; bank_ledger_id: string; reconciled_at: string | null }>(
    ctx.db, 'select amount, kind, status, bank_ledger_id, reconciled_at from payment where id = $1 for update', [paymentId]);
  if (!payment || payment.bank_ledger_id !== reconciliation.ledger_id) {
    throw new Error('payment does not belong to this bank account');
  }
  if (payment.status !== 'approved') throw new Error('only an approved payment can be reconciled');
  if (payment.reconciled_at) throw new Error('payment is already reconciled');
  const signedPayment = round2(payment.kind === 'receipt' ? payment.amount : -payment.amount);
  if (signedPayment !== round2(line.amount)) {
    throw new Error(`statement amount ${round2(line.amount).toFixed(2)} does not equal payment ${signedPayment.toFixed(2)}`);
  }

  await ctx.db.query(
    `update bank_statement_line set matched_payment_id = $1, matched_by = $2, matched_at = now()
      where id = $3`, [paymentId, ctx.userId, lineId]);
  await ctx.db.query('update payment set reconciled_at = now() where id = $1', [paymentId]);
  return { matched: true };
}

export async function unmatchStatementLine(ctx: Ctx, reconciliationId: string, lineId: string) {
  const reconciliation = await lockedReconciliation(ctx, reconciliationId);
  if (!reconciliation) throw new Error('bank reconciliation not found');
  if (reconciliation.status !== 'draft') throw new Error('only a draft reconciliation can be changed');
  const line = await one<{ matched_payment_id: string | null }>(ctx.db,
    `select matched_payment_id from bank_statement_line
      where id = $1 and reconciliation_id = $2 for update`, [lineId, reconciliationId]);
  if (!line) throw new Error('bank statement line not found');
  if (!line.matched_payment_id) throw new Error('bank statement line is not matched');
  await ctx.db.query('update payment set reconciled_at = null where id = $1', [line.matched_payment_id]);
  await ctx.db.query(
    `update bank_statement_line set matched_payment_id = null, matched_by = null, matched_at = null
      where id = $1`, [lineId]);
  return { matched: false };
}

export async function completeReconciliation(ctx: Ctx, id: string) {
  const reconciliation = await lockedReconciliation(ctx, id);
  if (!reconciliation) throw new Error('bank reconciliation not found');
  if (reconciliation.status !== 'draft') throw new Error('only a draft reconciliation can be completed');
  if (reconciliation.created_by === ctx.userId) {
    throw new Error('the person who prepared a bank reconciliation cannot complete it');
  }
  const summary = await balanceSummary(ctx, reconciliation);
  if (summary.matchedLines !== summary.statementLines) {
    throw new Error(`${summary.statementLines - summary.matchedLines} bank statement line(s) are still unmatched`);
  }
  if (Math.abs(summary.statementArithmeticDifference) > 0.005) {
    throw new Error('the imported bank statement does not add up');
  }
  if (Math.abs(summary.difference) > 0.005) {
    throw new Error(`bank and book reconciliation is out by ${summary.difference.toFixed(2)}`);
  }
  await ctx.db.query(
    `update bank_reconciliation set status = 'completed', completed_by = $2, completed_at = now()
      where id = $1`, [id, ctx.userId]);
  return { completed: true, summary };
}

export async function cancelReconciliation(ctx: Ctx, id: string) {
  const reconciliation = await lockedReconciliation(ctx, id);
  if (!reconciliation) throw new Error('bank reconciliation not found');
  if (reconciliation.status !== 'draft') throw new Error('only a draft reconciliation can be cancelled');
  await ctx.db.query(
    `update payment set reconciled_at = null
      where id in (select matched_payment_id from bank_statement_line
                    where reconciliation_id = $1 and matched_payment_id is not null)`, [id]);
  await ctx.db.query(
    `update bank_statement_line set matched_payment_id = null, matched_by = null, matched_at = null
      where reconciliation_id = $1 and matched_payment_id is not null`, [id]);
  await ctx.db.query("update bank_reconciliation set status = 'cancelled' where id = $1", [id]);
  return { cancelled: true };
}
