import { many, one, nextDocNumber } from './db.ts';
import { apportion, round2, sumBy } from './money.ts';
import { capitaliseJobwork } from './valuation.ts';
import { shrinkagePoliciesFor } from './config.ts';
import type { Ctx } from './domain.ts';

/**
 * Receiving from a process house that cannot return the barcodes it was sent.
 *
 * The piece-wise receipt matches every barcode back to its issue line. That
 * holds where a label survives processing and fails completely where it does
 * not: thaans stitched end to end into one batch for the jet, cut into
 * finished lengths at the inspection table, nothing coming back as itself.
 *
 * Here the mill agrees quantities against the *issue*. The pieces that went
 * out are consumed, the finished pieces are created with fresh barcodes, and
 * the cost that sat on the parents follows the children to the paise.
 */

export interface LotPieceInput {
  barcode: string;
  qty: number;
  weightKg?: number | null;
  finishGrade: string;
  rackCode?: string | null;
}

const COST_FIELDS = ['grey_cost', 'jobwork_cost', 'other_cost'] as const;
type CostField = (typeof COST_FIELDS)[number];

interface OutstandingLine {
  issue_line_id: string;
  piece_id: string;
  barcode: string;
  issued_qty: number;
  issued_weight_kg: number | null;
  quality_id: string;
  design_id: string | null;
  grade_code: string;
  lot_no: string;
  uom: string;
  status: string;
  business_location_id: string | null;
  grey_cost: number;
  jobwork_cost: number;
  other_cost: number;
}

export async function postLotReceipt(
  ctx: Ctx,
  header: {
    issueId: string;
    challanNo: string;
    challanDate: string;
    entryDate: string;
    jobRate: number;
    remarks?: string;
  },
  pieces: LotPieceInput[]
) {
  if (pieces.length === 0) throw new Error('a receipt needs at least one finished piece');
  if (pieces.some(p => !(p.qty > 0))) throw new Error('every finished piece needs a length');

  const issue = await one<{ id: string; entry_no: string; process_house_id: string; lot_no: string }>(
    ctx.db,
    `select id, entry_no, process_house_id, lot_no from dyeing_issue
      where id = $1 and is_live(status)`,
    [header.issueId]
  );
  if (!issue) throw new Error('no live dyeing issue with that id');

  // Everything still out against this issue, locked for the duration.
  const outstanding = await many<OutstandingLine>(
    ctx.db,
    `select il.id as issue_line_id, p.id as piece_id, p.barcode,
            il.issued_qty, il.issued_weight_kg,
            p.quality_id, p.design_id, p.grade_code, p.lot_no, p.uom, p.status::text,
            p.business_location_id, p.grey_cost, p.jobwork_cost, p.other_cost
       from dyeing_issue_line il
       join piece p on p.id = il.piece_id
      where il.issue_id = $1
        and p.status in ('issued_to_dyeing', 'reprocess_at_process_house')
        and not exists (select 1 from dyeing_receipt_line rl
                         where rl.issue_line_id = il.id and rl.active)
      order by p.id
      for update of p, il`,
    [header.issueId]
  );
  if (outstanding.length === 0) {
    throw new Error(`nothing is still out against ${issue.entry_no}`);
  }

  const issuedTotal = round2(sumBy(outstanding, o => Number(o.issued_qty)));
  const receivedTotal = round2(sumBy(pieces, p => p.qty));

  await assertLotShrinkageAllowed(ctx, issue.process_house_id, outstanding, issuedTotal, receivedTotal);

  const barcodes = pieces.map(p => p.barcode.trim());
  if (barcodes.some(b => b.length === 0)) throw new Error('every finished piece needs a barcode');
  if (new Set(barcodes).size !== barcodes.length) {
    throw new Error('the finished barcodes must all differ');
  }
  const clash = await many<{ barcode: string }>(
    ctx.db, 'select barcode from piece where barcode = any($1::text[])', [barcodes]
  );
  if (clash.length > 0) {
    throw new Error(`barcode already in use: ${clash.map(c => c.barcode).join(', ')}`);
  }

  const qtys = pieces.map(p => p.qty);

  /**
   * The whole lot's cost is pooled and split across the finished pieces by
   * length. It cannot be traced piece to piece — the process house returned a
   * batch — and apportioning by length is the only division that conserves
   * the total to the paise.
   */
  const pooled = Object.fromEntries(
    COST_FIELDS.map(f => [f, round2(sumBy(outstanding, o => Number(o[f])))])
  ) as Record<CostField, number>;
  const shares = Object.fromEntries(
    COST_FIELDS.map(f => [f, apportion(pooled[f], qtys)])
  ) as Record<CostField, number[]>;

  // Grey length rides along the same way, so shrinkage stays readable on the
  // finished piece: it knows how much grey it is made of.
  const greyShares = apportion(issuedTotal, qtys);

  const first = outstanding[0]!;
  const children = await many<{ id: string; barcode: string }>(
    ctx.db,
    `insert into piece (tenant_id, barcode, quality_id, design_id, grade_code, lot_no,
                        status, grey_qty, finish_qty, current_qty, current_weight_kg,
                        finish_weight_kg, uom,
                        grey_cost, jobwork_cost, other_cost, business_location_id, rack_code)
     select $1, x.barcode, $2, $3, x.grade, $4, 'received_finish'::piece_status,
            x.grey_qty, x.qty, x.qty, x.weight_kg, x.weight_kg, $5,
            x.grey, x.jobwork, x.other, $6, x.rack
       from unnest($7::text[], $8::numeric[], $9::numeric[], $10::numeric[], $11::text[],
                   $12::numeric[], $13::numeric[], $14::numeric[], $15::text[])
            as x(barcode, qty, grey_qty, weight_kg, grade, grey, jobwork, other, rack)
     returning id, barcode`,
    [
      ctx.tenantId, first.quality_id, first.design_id, issue.lot_no || first.lot_no,
      first.uom, first.business_location_id,
      barcodes, qtys, greyShares,
      pieces.map(p => p.weightKg ?? null),
      pieces.map(p => p.finishGrade),
      shares.grey_cost, shares.jobwork_cost, shares.other_cost,
      pieces.map(p => p.rackCode ?? null)
    ]
  );
  const idOf = new Map(children.map(c => [c.barcode, c.id]));

  // The cost left with the children; leaving it on the parents as well would
  // value the same rupees twice in any total taken across every piece.
  await ctx.db.query(
    'update piece set grey_cost = 0, jobwork_cost = 0, other_cost = 0 where id = any($1::uuid[])',
    [outstanding.map(o => o.piece_id)]
  );

  const regroup = await writeProcessReturn(
    ctx, header.entryDate, issue.entry_no, outstanding, barcodes, qtys, idOf
  );

  const entryNo = await nextDocNumber(ctx.db, ctx.tenantId, 'dyeing_receipt', ctx.fy);
  const receipt = await one<{ id: string }>(
    ctx.db,
    `insert into dyeing_receipt (tenant_id, entry_no, entry_date, process_house_id,
                                 challan_no, challan_date, remarks, status, created_by,
                                 receipt_mode, issue_id, regroup_id)
     values ($1,$2,$3,$4,$5,$6,$7,'approved',$8,'lot',$9,$10) returning id`,
    [ctx.tenantId, entryNo, header.entryDate, issue.process_house_id,
     header.challanNo, header.challanDate, header.remarks ?? '', ctx.userId,
     issue.id, regroup.id]
  );
  if (!receipt) throw new Error('receipt insert returned nothing');

  /**
   * One receipt line per issue line, carrying that line's pro-rata share of
   * what the lot returned. Nobody can say which grey thaan became which
   * finished thaan, so the share is stated rather than invented — and every
   * report built on receipt lines keeps working.
   */
  const perLine = apportion(receivedTotal, outstanding.map(o => Number(o.issued_qty)));
  await ctx.db.query(
    `insert into dyeing_receipt_line (tenant_id, receipt_id, issue_line_id, piece_id, sno,
                                      issued_qty, received_qty, job_rate, finish_grade)
     select $1, $2, x.issue_line_id, x.piece_id, x.sno, x.issued_qty, x.received_qty,
            $3, $4
       from unnest($5::uuid[], $6::uuid[], $7::smallint[], $8::numeric[], $9::numeric[])
            as x(issue_line_id, piece_id, sno, issued_qty, received_qty)`,
    [
      ctx.tenantId, receipt.id, header.jobRate, pieces[0]!.finishGrade,
      outstanding.map(o => o.issue_line_id), outstanding.map(o => o.piece_id),
      outstanding.map((_, i) => i + 1), outstanding.map(o => o.issued_qty), perLine
    ]
  );

  const jobwork = round2(receivedTotal * header.jobRate);
  const voucherId = jobwork > 0
    ? await capitaliseJobwork(
        ctx, receipt.id,
        children.map((c, i) => ({
          pieceId: c.id,
          cost: apportion(jobwork, qtys)[i]!
        })),
        issue.process_house_id, header.entryDate, entryNo
      )
    : null;

  return {
    id: receipt.id, entryNo, mode: 'lot' as const,
    issueEntryNo: issue.entry_no,
    thaansSent: outstanding.length, thaansReturned: children.length,
    issuedQty: issuedTotal, receivedQty: receivedTotal,
    shrinkageQty: round2(issuedTotal - receivedTotal),
    shrinkagePct: issuedTotal > 0
      ? round2(((issuedTotal - receivedTotal) * 100) / issuedTotal) : 0,
    jobworkValue: jobwork,
    barcodes: children.map(c => c.barcode),
    voucherId
  };
}

/**
 * The agreed loss for the lot, judged once against the whole batch. A
 * per-piece limit means nothing when the pieces coming back are not the
 * pieces that went out.
 */
async function assertLotShrinkageAllowed(
  ctx: Ctx, processHouseId: string, outstanding: OutstandingLine[],
  issuedTotal: number, receivedTotal: number
) {
  if (issuedTotal <= 0) return;
  const policies = await shrinkagePoliciesFor(
    ctx.db, ctx.tenantId, processHouseId, [...new Set(outstanding.map(o => o.quality_id))]
  );
  // Several qualities in one batch: the tightest limit governs the lot.
  let maxPct = Infinity;
  let gainPct = Infinity;
  for (const quality of new Set(outstanding.map(o => o.quality_id))) {
    const policy = policies.get(quality);
    maxPct = Math.min(maxPct, policy?.maxPct ?? 12);
    gainPct = Math.min(gainPct, policy?.gainPct ?? 1);
  }
  const pct = ((issuedTotal - receivedTotal) * 100) / issuedTotal;
  if (pct > maxPct) {
    throw new Error(
      `the lot lost ${pct.toFixed(2)}% against a ${maxPct}% limit ` +
      `(${issuedTotal} out, ${receivedTotal} back)`
    );
  }
  if (pct < -gainPct) {
    throw new Error(
      `the lot gained ${(-pct).toFixed(2)}%, beyond the ${gainPct}% allowance ` +
      `(${issuedTotal} out, ${receivedTotal} back)`
    );
  }
}

/** Consumes the thaans that went out and records what came back in their place. */
async function writeProcessReturn(
  ctx: Ctx, entryDate: string, issueEntryNo: string,
  outstanding: OutstandingLine[], barcodes: string[], qtys: number[],
  idOf: Map<string, string>
) {
  const entryNo = await nextDocNumber(ctx.db, ctx.tenantId, 'piece_regroup', ctx.fy);
  const reason = `Returned from process against ${issueEntryNo}`;
  const header = await one<{ id: string }>(
    ctx.db,
    `insert into piece_regroup (tenant_id, entry_no, entry_date, kind, reason, created_by)
     values ($1,$2,$3,'process_return',$4,$5) returning id`,
    [ctx.tenantId, entryNo, entryDate, reason, ctx.userId]
  );
  if (!header) throw new Error('regroup insert returned nothing');

  await ctx.db.query(
    `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                                 qty_before, qty_after, doc_type, doc_id, created_by, note)
     select $1, x.piece_id, 'process_return'::movement_event, x.status::piece_status, 'consumed',
            x.qty, 0, 'piece_regroup', $2, $3, $4
       from unnest($5::uuid[], $6::text[], $7::numeric[]) as x(piece_id, status, qty)`,
    [ctx.tenantId, header.id, ctx.userId, reason,
     outstanding.map(o => o.piece_id), outstanding.map(o => o.status),
     outstanding.map(o => Number(o.issued_qty))]
  );

  await ctx.db.query(
    `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                                 qty_before, qty_after, doc_type, doc_id, created_by, note)
     select $1, x.piece_id, 'process_return'::movement_event, null, 'received_finish'::piece_status,
            0, x.qty, 'piece_regroup', $2, $3, $4
       from unnest($5::uuid[], $6::numeric[]) as x(piece_id, qty)`,
    [ctx.tenantId, header.id, ctx.userId, reason,
     barcodes.map(b => idOf.get(b)!), qtys]
  );

  /**
   * Every thaan sent is a parent of every thaan returned. The batch really
   * was mixed, and a lineage that named one parent per child would be a
   * tidier lie than the truth.
   */
  const parents: string[] = [];
  const kids: string[] = [];
  const shares: number[] = [];
  const issuedTotal = sumBy(outstanding, o => Number(o.issued_qty));
  for (const parent of outstanding) {
    const weight = issuedTotal > 0 ? Number(parent.issued_qty) / issuedTotal : 0;
    for (let i = 0; i < barcodes.length; i++) {
      parents.push(parent.piece_id);
      kids.push(idOf.get(barcodes[i]!)!);
      shares.push(round2(qtys[i]! * weight));
    }
  }
  await ctx.db.query(
    `insert into piece_lineage (tenant_id, regroup_id, parent_id, child_id, qty)
     select $1, $2, x.parent_id, x.child_id, greatest(x.qty, 0.01)
       from unnest($3::uuid[], $4::uuid[], $5::numeric[])
            as x(parent_id, child_id, qty)`,
    [ctx.tenantId, header.id, parents, kids, shares]
  );

  return { id: header.id, entryNo };
}
