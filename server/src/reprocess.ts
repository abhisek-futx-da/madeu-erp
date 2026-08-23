import { many, one, nextDocNumber } from './db.ts';
import type { Ctx } from './domain.ts';
import { approvalFor, holdVoucher, recordEvent } from './approvals.ts';
import { postVoucher } from './payments.ts';
import { roleLedgers } from './valuation.ts';
import { shrinkagePoliciesFor } from './config.ts';
import { round2, sumBy } from './money.ts';

export interface ReprocessIssueInput {
  processHouseId: string;
  issueDate: string;
  challanNo: string;
  challanDate: string;
  reason: string;
  barcodes: string[];
}

export interface ReprocessReceiptInput {
  reprocessId: string;
  receiptDate: string;
  challanNo: string;
  challanDate: string;
  remarks?: string;
  lines: {
    barcode: string;
    receivedQty: number;
    additionalRate: number;
    finishGrade: string;
  }[];
}

export async function postReprocessIssue(ctx: Ctx, input: ReprocessIssueInput) {
  if (new Set(input.barcodes).size !== input.barcodes.length) {
    throw new Error('a piece can appear only once on a reprocess challan');
  }
  const pieces = await many<{
    id: string; barcode: string; status: string; current_qty: number; grade_code: string;
  }>(ctx.db,
    `select id, barcode, status::text, current_qty, grade_code
       from piece where barcode = any($1::text[]) order by id for update`,
    [input.barcodes]);
  const byBarcode = new Map(pieces.map(piece => [piece.barcode, piece]));
  for (const barcode of input.barcodes) {
    const piece = byBarcode.get(barcode);
    if (!piece) throw new Error(`piece not found: ${barcode}`);
    if (piece.status !== 'received_finish') {
      throw new Error(`${barcode} is ${piece.status}, not received finish stock`);
    }
    if (Number(piece.current_qty) <= 0) throw new Error(`${barcode} has no quantity to reprocess`);
  }

  const issueNo = await nextDocNumber(ctx.db, ctx.tenantId, 'dyeing_reprocess', ctx.fy);
  const doc = await one<{ id: string }>(ctx.db,
    `insert into dyeing_reprocess
       (tenant_id, issue_no, issue_date, process_house_id, challan_no, challan_date,
        reason, status, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,'approved',$8) returning id`,
    [ctx.tenantId, issueNo, input.issueDate, input.processHouseId, input.challanNo,
     input.challanDate, input.reason, ctx.userId]);
  if (!doc) throw new Error('reprocess issue insert returned nothing');

  const ordered = input.barcodes.map(barcode => byBarcode.get(barcode)!);
  await ctx.db.query(
    `insert into dyeing_reprocess_line
       (tenant_id, reprocess_id, piece_id, sno, issued_qty, original_grade)
     select $1,$2,x.piece_id,x.sno,x.qty,x.grade
       from unnest($3::uuid[], $4::smallint[], $5::numeric[], $6::text[])
            as x(piece_id,sno,qty,grade)`,
    [ctx.tenantId, doc.id, ordered.map(p => p.id), ordered.map((_, i) => i + 1),
     ordered.map(p => Number(p.current_qty)), ordered.map(p => p.grade_code)]);

  await ctx.db.query(
    `insert into piece_movement
       (tenant_id,piece_id,event,from_status,to_status,qty_before,qty_after,
        counterparty_id,doc_type,doc_id,created_by,note)
     select $1,x.piece_id,'send_reprocess','received_finish','reprocess_at_process_house',
            x.qty,x.qty,$2,'dyeing_reprocess',$3,$4,$5
       from unnest($6::uuid[], $7::numeric[]) as x(piece_id,qty)`,
    [ctx.tenantId, input.processHouseId, doc.id, ctx.userId, input.reason,
     ordered.map(p => p.id), ordered.map(p => Number(p.current_qty))]);

  return {
    id: doc.id, issueNo, status: 'approved', pieces: ordered.length,
    qty: round2(sumBy(ordered, piece => Number(piece.current_qty)))
  };
}

export async function postReprocessReceipt(ctx: Ctx, input: ReprocessReceiptInput) {
  if (new Set(input.lines.map(line => line.barcode)).size !== input.lines.length) {
    throw new Error('a piece can appear only once on a reprocess receipt');
  }
  const reprocess = await one<{ id: string; issue_no: string; process_house_id: string; status: string }>(ctx.db,
    `select id, issue_no, process_house_id, status::text
       from dyeing_reprocess where id = $1 for update`, [input.reprocessId]);
  if (!reprocess) throw new Error('reprocess issue not found');
  if (reprocess.status === 'cancelled' || reprocess.status === 'closed') {
    throw new Error(`${reprocess.issue_no} is ${reprocess.status}`);
  }

  const barcodes = input.lines.map(line => line.barcode);
  const sources = await many<{
    reprocess_line_id: string; piece_id: string; barcode: string; issued_qty: number;
    status: string; held_by_ledger_id: string | null; quality_id: string;
  }>(ctx.db,
    `select rl.id as reprocess_line_id, p.id as piece_id, p.barcode, rl.issued_qty,
            p.status::text, p.held_by_ledger_id, p.quality_id
       from dyeing_reprocess_line rl
       join piece p on p.id = rl.piece_id
      where rl.reprocess_id = $1 and p.barcode = any($2::text[])
        and not exists (
          select 1 from dyeing_reprocess_receipt_line rrl
          join dyeing_reprocess_receipt rr on rr.id = rrl.receipt_id
           where rrl.reprocess_line_id = rl.id and rr.status not in ('rejected','cancelled')
        )
      order by rl.id for update of rl, p`,
    [input.reprocessId, barcodes]);
  const byBarcode = new Map(sources.map(source => [source.barcode, source]));
  for (const line of input.lines) {
    const source = byBarcode.get(line.barcode);
    if (!source) throw new Error(`${line.barcode} is not outstanding on ${reprocess.issue_no}`);
    if (source.status !== 'reprocess_at_process_house' || source.held_by_ledger_id !== reprocess.process_house_id) {
      throw new Error(`${line.barcode} is no longer at that process house`);
    }
  }

  const policies = await shrinkagePoliciesFor(
    ctx.db, ctx.tenantId, reprocess.process_house_id, sources.map(source => source.quality_id));
  const breaches: string[] = [];
  for (const line of input.lines) {
    const source = byBarcode.get(line.barcode)!;
    const issued = Number(source.issued_qty);
    const pct = ((issued - line.receivedQty) * 100) / issued;
    const policy = policies.get(source.quality_id) ?? { maxPct: 12, gainPct: 1 };
    if (pct > policy.maxPct) breaches.push(`${line.barcode} lost ${pct.toFixed(2)}% against ${policy.maxPct}%`);
    if (pct < -policy.gainPct) breaches.push(`${line.barcode} gained ${(-pct).toFixed(2)}% beyond ${policy.gainPct}%`);
  }
  if (breaches.length) throw new Error(`reprocess shrinkage outside policy: ${breaches.join('; ')}`);

  const receiptNo = await nextDocNumber(ctx.db, ctx.tenantId, 'dyeing_reprocess_receipt', ctx.fy);
  const amount = round2(sumBy(input.lines, line => round2(line.receivedQty * line.additionalRate)));
  const held = await approvalFor(ctx.db, 'dyeing_reprocess_receipt', amount);
  const status = held ? 'pending_approval' : 'approved';
  const receipt = await one<{ id: string }>(ctx.db,
    `insert into dyeing_reprocess_receipt
       (tenant_id,reprocess_id,receipt_no,receipt_date,challan_no,challan_date,
        remarks,amount,status,created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [ctx.tenantId, input.reprocessId, receiptNo, input.receiptDate, input.challanNo,
     input.challanDate, input.remarks ?? '', amount, status, ctx.userId]);
  if (!receipt) throw new Error('reprocess receipt insert returned nothing');

  const resolved = input.lines.map((line, index) => ({ ...line, index, source: byBarcode.get(line.barcode)! }));
  await ctx.db.query(
    `insert into dyeing_reprocess_receipt_line
       (tenant_id,receipt_id,reprocess_line_id,piece_id,sno,issued_qty,received_qty,
        additional_rate,finish_grade)
     select $1,$2,x.source_id,x.piece_id,x.sno,x.issued,x.received,x.rate,x.grade
       from unnest($3::uuid[], $4::uuid[], $5::smallint[], $6::numeric[],
                   $7::numeric[], $8::numeric[], $9::text[])
            as x(source_id,piece_id,sno,issued,received,rate,grade)`,
    [ctx.tenantId, receipt.id, resolved.map(r => r.source.reprocess_line_id),
     resolved.map(r => r.source.piece_id), resolved.map(r => r.index + 1),
     resolved.map(r => Number(r.source.issued_qty)), resolved.map(r => r.receivedQty),
     resolved.map(r => r.additionalRate), resolved.map(r => r.finishGrade)]);

  const ledgers = await roleLedgers(ctx.db);
  const postings = amount > 0 ? [
    { ledgerId: ledgers.need('inventory_finish'), debit: amount },
    { ledgerId: reprocess.process_house_id, credit: amount }
  ] : [];
  if (held) {
    if (amount > 0) {
      await holdVoucher(ctx, 'dyeing_reprocess_receipt', receipt.id, 'jobwork', input.receiptDate,
        `Reprocess receipt ${receiptNo}`, postings);
    }
    await recordEvent(ctx, 'dyeing_reprocess_receipt', receipt.id, 'submitted', amount);
  } else {
    await applyReprocessReceipt(ctx, receipt.id);
    if (amount > 0) {
      const voucher = await postVoucher(ctx, 'jobwork', input.receiptDate,
        `Reprocess receipt ${receiptNo}`, 'dyeing_reprocess_receipt', receipt.id, postings);
      await ctx.db.query('update dyeing_reprocess_receipt set voucher_id = $2 where id = $1',
        [receipt.id, voucher]);
    }
  }

  return { id: receipt.id, receiptNo, status, amount, pieces: resolved.length };
}

/** Called directly for an unheld receipt, or after its held voucher is posted. */
export async function applyReprocessReceipt(ctx: Ctx, receiptId: string) {
  const receipt = await one<{ reprocess_id: string; process_house_id: string }>(ctx.db,
    `select rr.reprocess_id, rp.process_house_id
       from dyeing_reprocess_receipt rr
       join dyeing_reprocess rp on rp.id = rr.reprocess_id
      where rr.id = $1`, [receiptId]);
  if (!receipt) throw new Error('reprocess receipt not found');
  const lines = await many<{
    piece_id: string; issued_qty: number; received_qty: number;
    additional_amount: number; finish_grade: string; status: string; held_by_ledger_id: string | null;
  }>(ctx.db,
    `select rrl.piece_id, rrl.issued_qty, rrl.received_qty, rrl.additional_amount,
            rrl.finish_grade, p.status::text, p.held_by_ledger_id
       from dyeing_reprocess_receipt_line rrl
       join piece p on p.id = rrl.piece_id
      where rrl.receipt_id = $1 order by rrl.sno for update of p`, [receiptId]);
  for (const line of lines) {
    if (line.status !== 'reprocess_at_process_house' || line.held_by_ledger_id !== receipt.process_house_id) {
      throw new Error('reprocess stock changed while its receipt waited for approval');
    }
  }

  await ctx.db.query(
    `update piece p
        set finish_qty = x.qty, grade_code = x.grade,
            jobwork_cost = p.jobwork_cost + x.cost
       from unnest($1::uuid[], $2::numeric[], $3::text[], $4::numeric[])
            as x(piece_id,qty,grade,cost)
      where p.id = x.piece_id`,
    [lines.map(line => line.piece_id), lines.map(line => Number(line.received_qty)),
     lines.map(line => line.finish_grade), lines.map(line => Number(line.additional_amount))]);
  await ctx.db.query(
    `insert into piece_movement
       (tenant_id,piece_id,event,from_status,to_status,qty_before,qty_after,
        doc_type,doc_id,created_by)
     select $1,x.piece_id,'receive_reprocess','reprocess_at_process_house','received_finish',
            x.before_qty,x.after_qty,'dyeing_reprocess_receipt',$2,$3
       from unnest($4::uuid[], $5::numeric[], $6::numeric[])
            as x(piece_id,before_qty,after_qty)`,
    [ctx.tenantId, receiptId, ctx.userId, lines.map(line => line.piece_id),
     lines.map(line => Number(line.issued_qty)), lines.map(line => Number(line.received_qty))]);

  const outstanding = await one<{ n: number }>(ctx.db,
    `select count(*)::int as n from dyeing_reprocess_line rl
      where rl.reprocess_id = $1
        and not exists (
          select 1 from dyeing_reprocess_receipt_line rrl
          join dyeing_reprocess_receipt rr on rr.id = rrl.receipt_id
           where rrl.reprocess_line_id = rl.id and rr.status = 'approved'
        )`, [receipt.reprocess_id]);
  await ctx.db.query(`update dyeing_reprocess set status = $2 where id = $1`,
    [receipt.reprocess_id, Number(outstanding?.n ?? 0) === 0 ? 'closed' : 'partly_done']);
}
