import { many, one, nextDocNumber, type Db } from './db.ts';
import { capitaliseGrey, capitaliseJobwork, releaseCostOfSales } from './valuation.ts';
import { shrinkagePoliciesFor, creditBreach, settings, boolSetting } from './config.ts';
import { round2, sumBy } from './money.ts';

/**
 * Document posting. Two rules hold everywhere in this file:
 *  - a piece never changes status by UPDATE; it changes by inserting a movement
 *  - nothing is queried per line; every statement is batched over the whole set
 */

export interface Ctx {
  db: Db;
  tenantId: string;
  userId: string;
  fy: string;
}

// ------------------------------------------------------------------ inward --

export interface InwardLineInput {
  poLineId?: string | null;
  qualityId: string;
  designId?: string | null;
  gradeCode: string;
  barcode: string;
  lotNo: string;
  receivedQty: number;
  checkedQty: number;
  rate: number;
  /** Where it was put down. Without this a physical count has nothing to check against. */
  rackCode?: string | null;
}

/** Grey arrives: one piece per thaan, each with its own barcode and movement. */
export async function postGreyInward(
  ctx: Ctx,
  header: {
    partyId: string;
    challanNo: string;
    challanDate: string;
    entryDate: string;
    lotNo: string;
    transportId?: string | null;
    brokerId?: string | null;
    lrNo?: string | null;
    directIssue?: boolean;
    remarks?: string;
    /** Default shelf for the whole challan; a line may name its own. */
    rackCode?: string | null;
  },
  lines: InwardLineInput[]
) {
  if (lines.length === 0) throw new Error('an inward needs at least one piece');

  const entryNo = await nextDocNumber(ctx.db, ctx.tenantId, 'grey_inward', ctx.fy);
  const inward = await one<{ id: string }>(
    ctx.db,
    `insert into grey_inward (tenant_id, entry_no, entry_date, party_id, challan_no,
                              challan_date, lot_no, transport_id, broker_id, lr_no,
                              direct_issue, remarks, status, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'approved',$13) returning id`,
    [
      ctx.tenantId, entryNo, header.entryDate, header.partyId, header.challanNo,
      header.challanDate, header.lotNo, header.transportId ?? null, header.brokerId ?? null,
      header.lrNo ?? null, header.directIssue ?? false, header.remarks ?? '', ctx.userId
    ]
  );
  if (!inward) throw new Error('inward insert returned nothing');

  // One statement for every piece, whatever the challan size.
  const pieces = await many<{ id: string; barcode: string }>(
    ctx.db,
    `insert into piece (tenant_id, barcode, quality_id, design_id, grade_code, lot_no,
                        status, held_by_ledger_id, grey_qty, current_qty, rack_code)
     select $1, x.barcode, x.quality_id, x.design_id, x.grade_code, x.lot_no,
            'grey_in_stock', null, x.qty, x.qty, x.rack_code
       from unnest($2::text[], $3::uuid[], $4::uuid[], $5::text[], $6::text[],
                   $7::numeric[], $8::text[])
            as x(barcode, quality_id, design_id, grade_code, lot_no, qty, rack_code)
     returning id, barcode`,
    [
      ctx.tenantId,
      lines.map(l => l.barcode),
      lines.map(l => l.qualityId),
      lines.map(l => l.designId ?? null),
      lines.map(l => l.gradeCode),
      lines.map(l => l.lotNo || header.lotNo),
      lines.map(l => l.checkedQty),
      lines.map(l => l.rackCode ?? header.rackCode ?? null)
    ]
  );

  const pieceByBarcode = new Map(pieces.map(p => [p.barcode, p.id]));
  const pieceIds = lines.map(l => {
    const id = pieceByBarcode.get(l.barcode);
    if (!id) throw new Error(`piece not created for barcode ${l.barcode}`);
    return id;
  });

  await ctx.db.query(
    `insert into grey_inward_line (tenant_id, inward_id, po_line_id, piece_id, sno,
                                   received_qty, checked_qty, rate)
     select $1, $2, x.po_line_id, x.piece_id, x.sno, x.received_qty, x.checked_qty, x.rate
       from unnest($3::uuid[], $4::uuid[], $5::smallint[], $6::numeric[], $7::numeric[], $8::numeric[])
            as x(po_line_id, piece_id, sno, received_qty, checked_qty, rate)`,
    [
      ctx.tenantId, inward.id,
      lines.map(l => l.poLineId ?? null),
      pieceIds,
      lines.map((_, i) => i + 1),
      lines.map(l => l.receivedQty),
      lines.map(l => l.checkedQty),
      lines.map(l => l.rate)
    ]
  );

  await ctx.db.query(
    `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                                 qty_before, qty_after, counterparty_id, doc_type, doc_id, created_by)
     select $1, x.piece_id, 'inward', null, 'grey_in_stock', 0, x.qty, $2, 'grey_inward', $3, $4
       from unnest($5::uuid[], $6::numeric[]) as x(piece_id, qty)`,
    [ctx.tenantId, header.partyId, inward.id, ctx.userId, pieceIds, lines.map(l => l.checkedQty)]
  );

  // Consume PO balance in one pass, not one update per line.
  const withPo = lines.map((l, i) => ({ l, i })).filter(x => x.l.poLineId);
  if (withPo.length > 0) {
    await ctx.db.query(
      `update grey_purchase_order_line ol
          set received_qty = ol.received_qty + x.qty
         from unnest($1::uuid[], $2::numeric[]) as x(po_line_id, qty)
        where ol.id = x.po_line_id`,
      [withPo.map(x => x.l.poLineId), withPo.map(x => x.l.checkedQty)]
    );
  }

  // Grey is an asset until it is sold, not an expense the day it arrives.
  const goods = sumBy(lines, l => round2(l.checkedQty * l.rate));
  await capitaliseGrey(
    ctx, inward.id,
    lines.map((l, i) => ({ pieceId: pieceIds[i]!, cost: l.checkedQty * l.rate })),
    header.partyId, header.entryDate, entryNo
  );

  return { id: inward.id, entryNo, pieces: pieceIds.length, value: round2(goods) };
}

// ------------------------------------------------------------------- issue --

export async function postDyeingIssue(
  ctx: Ctx,
  header: {
    processHouseId: string;
    weaverId?: string | null;
    challanNo: string;
    challanDate: string;
    entryDate: string;
    lotNo: string;
    noOfBales?: number;
    vehicleNo?: string | null;
    remarks?: string;
  },
  barcodes: string[],
  jobRate = 0
) {
  if (barcodes.length === 0) throw new Error('a dyeing challan needs at least one piece');

  const pieces = await many<{ id: string; barcode: string; status: string; current_qty: number }>(
    ctx.db,
    `select id, barcode, status, current_qty from piece
      where barcode = any($1::text[]) order by id for update`,
    [barcodes]
  );
  assertAllFound(barcodes, pieces);
  const wrong = pieces.filter(p => p.status !== 'grey_in_stock');
  if (wrong.length > 0) {
    throw new Error(
      `not in grey stock: ${wrong.map(p => `${p.barcode} (${p.status})`).join(', ')}`
    );
  }

  const entryNo = await nextDocNumber(ctx.db, ctx.tenantId, 'dyeing_issue', ctx.fy);
  const issue = await one<{ id: string }>(
    ctx.db,
    `insert into dyeing_issue (tenant_id, entry_no, entry_date, process_house_id, weaver_id,
                               challan_no, challan_date, lot_no, no_of_bales, vehicle_no,
                               remarks, status, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'approved',$12) returning id`,
    [
      ctx.tenantId, entryNo, header.entryDate, header.processHouseId, header.weaverId ?? null,
      header.challanNo, header.challanDate, header.lotNo, header.noOfBales ?? pieces.length,
      header.vehicleNo ?? null, header.remarks ?? '', ctx.userId
    ]
  );
  if (!issue) throw new Error('issue insert returned nothing');

  await ctx.db.query(
    `insert into dyeing_issue_line (tenant_id, issue_id, piece_id, sno, issued_qty, job_rate)
     select $1, $2, x.piece_id, x.sno, x.qty, $3
       from unnest($4::uuid[], $5::smallint[], $6::numeric[]) as x(piece_id, sno, qty)`,
    [
      ctx.tenantId, issue.id, jobRate,
      pieces.map(p => p.id),
      pieces.map((_, i) => i + 1),
      pieces.map(p => p.current_qty)
    ]
  );

  await ctx.db.query(
    `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                                 qty_before, qty_after, counterparty_id, doc_type, doc_id, created_by)
     select $1, x.piece_id, 'issue', 'grey_in_stock', 'issued_to_dyeing',
            x.qty, x.qty, $2, 'dyeing_issue', $3, $4
       from unnest($5::uuid[], $6::numeric[]) as x(piece_id, qty)`,
    [
      ctx.tenantId, header.processHouseId, issue.id, ctx.userId,
      pieces.map(p => p.id), pieces.map(p => p.current_qty)
    ]
  );

  return { id: issue.id, entryNo, pieces: pieces.length };
}

// ----------------------------------------------------------------- receipt --

export interface ReceiptLineInput {
  barcode: string;
  receivedQty: number;
  finishGrade: string;
  jobRate: number;
}

/** The return leg: finish comes back, shrinkage is reconciled, jobwork posts. */
export async function postDyeingReceipt(
  ctx: Ctx,
  header: {
    processHouseId: string;
    challanNo: string;
    challanDate: string;
    entryDate: string;
    remarks?: string;
  },
  lines: ReceiptLineInput[]
) {
  if (lines.length === 0) throw new Error('a receipt needs at least one piece');

  const barcodes = lines.map(l => l.barcode);
  const rows = await many<{
    piece_id: string; barcode: string; status: string; issue_line_id: string; issued_qty: number;
  }>(
    ctx.db,
    `select p.id as piece_id, p.barcode, p.status, il.id as issue_line_id, il.issued_qty
       from piece p
       join dyeing_issue_line il on il.piece_id = p.id
       join dyeing_issue di on di.id = il.issue_id
      where p.barcode = any($1::text[])
        and di.process_house_id = $2
        and not exists (select 1 from dyeing_receipt_line rl where rl.issue_line_id = il.id)
      order by p.id
      for update of p`,
    [barcodes, header.processHouseId]
  );
  assertAllFound(barcodes, rows.map(r => ({ barcode: r.barcode })));
  const wrong = rows.filter(r => r.status !== 'issued_to_dyeing');
  if (wrong.length > 0) {
    throw new Error(`not out at this process house: ${wrong.map(r => r.barcode).join(', ')}`);
  }

  const byBarcode = new Map(rows.map(r => [r.barcode, r]));

  // The per-mill shrinkage policy is enforced here, not merely displayed.
  const qualityRows = await many<{ piece_id: string; quality_id: string }>(
    ctx.db,
    'select id as piece_id, quality_id from piece where id = any($1::uuid[])',
    [rows.map(r => r.piece_id)]
  );
  const qualityOf = new Map(qualityRows.map(q => [q.piece_id, q.quality_id]));
  const policies = await shrinkagePoliciesFor(
    ctx.db, ctx.tenantId, header.processHouseId, [...qualityOf.values()]
  );
  const breaches: string[] = [];
  for (const l of lines) {
    const r = byBarcode.get(l.barcode)!;
    const issued = Number(r.issued_qty);
    if (issued <= 0) continue;
    const pct = ((issued - l.receivedQty) * 100) / issued;
    const policy = policies.get(qualityOf.get(r.piece_id) ?? '');
    const maxPct = policy?.maxPct ?? 12;
    const gainPct = policy?.gainPct ?? 1;
    if (pct > maxPct) {
      breaches.push(`${l.barcode} lost ${pct.toFixed(2)}% against a ${maxPct}% limit`);
    } else if (pct < -gainPct) {
      breaches.push(`${l.barcode} gained ${(-pct).toFixed(2)}%, beyond the ${gainPct}% allowance`);
    }
  }
  if (breaches.length > 0) {
    throw new Error(`shrinkage outside the agreed policy: ${breaches.join('; ')}`);
  }

  const entryNo = await nextDocNumber(ctx.db, ctx.tenantId, 'dyeing_receipt', ctx.fy);
  const receipt = await one<{ id: string }>(
    ctx.db,
    `insert into dyeing_receipt (tenant_id, entry_no, entry_date, process_house_id,
                                 challan_no, challan_date, remarks, status, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,'approved',$8) returning id`,
    [ctx.tenantId, entryNo, header.entryDate, header.processHouseId,
     header.challanNo, header.challanDate, header.remarks ?? '', ctx.userId]
  );
  if (!receipt) throw new Error('receipt insert returned nothing');

  const resolved = lines.map((l, i) => {
    const r = byBarcode.get(l.barcode)!;
    return { ...l, sno: i + 1, pieceId: r.piece_id, issueLineId: r.issue_line_id, issuedQty: r.issued_qty };
  });

  await ctx.db.query(
    `insert into dyeing_receipt_line (tenant_id, receipt_id, issue_line_id, piece_id, sno,
                                      issued_qty, received_qty, job_rate, finish_grade)
     select $1, $2, x.issue_line_id, x.piece_id, x.sno, x.issued_qty, x.received_qty,
            x.job_rate, x.finish_grade
       from unnest($3::uuid[], $4::uuid[], $5::smallint[], $6::numeric[], $7::numeric[],
                   $8::numeric[], $9::text[])
            as x(issue_line_id, piece_id, sno, issued_qty, received_qty, job_rate, finish_grade)`,
    [
      ctx.tenantId, receipt.id,
      resolved.map(r => r.issueLineId), resolved.map(r => r.pieceId),
      resolved.map(r => r.sno), resolved.map(r => r.issuedQty),
      resolved.map(r => r.receivedQty), resolved.map(r => r.jobRate),
      resolved.map(r => r.finishGrade)
    ]
  );

  await ctx.db.query(
    `update piece p set finish_qty = x.qty, grade_code = x.grade
       from unnest($1::uuid[], $2::numeric[], $3::text[]) as x(piece_id, qty, grade)
      where p.id = x.piece_id`,
    [resolved.map(r => r.pieceId), resolved.map(r => r.receivedQty), resolved.map(r => r.finishGrade)]
  );

  await ctx.db.query(
    `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                                 qty_before, qty_after, counterparty_id, doc_type, doc_id, created_by)
     select $1, x.piece_id, 'receipt', 'issued_to_dyeing', 'received_finish',
            x.before_qty, x.after_qty, null, 'dyeing_receipt', $2, $3
       from unnest($4::uuid[], $5::numeric[], $6::numeric[]) as x(piece_id, before_qty, after_qty)`,
    [
      ctx.tenantId, receipt.id, ctx.userId,
      resolved.map(r => r.pieceId), resolved.map(r => r.issuedQty), resolved.map(r => r.receivedQty)
    ]
  );

  const jobwork = sumBy(resolved, r => round2(r.receivedQty * r.jobRate));
  await capitaliseJobwork(
    ctx, receipt.id,
    resolved.map(r => ({ pieceId: r.pieceId, cost: r.receivedQty * r.jobRate })),
    header.processHouseId, header.entryDate, entryNo
  );

  const issued = sumBy(resolved, r => r.issuedQty);
  const received = sumBy(resolved, r => r.receivedQty);
  return {
    id: receipt.id,
    entryNo,
    pieces: resolved.length,
    issuedQty: round2(issued),
    receivedQty: round2(received),
    shrinkagePct: issued > 0 ? round2(((issued - received) * 100) / issued) : 0,
    jobwork: round2(jobwork)
  };
}

// ---------------------------------------------------------------- dispatch --

export async function postDispatch(
  ctx: Ctx,
  header: {
    partyId: string;
    challanNo: string;
    challanDate: string;
    transportId?: string | null;
    lrNo?: string | null;
    vehicleNo?: string | null;
  },
  lines: { barcode: string; rate: number; soLineId?: string | null }[]
) {
  if (lines.length === 0) throw new Error('a dispatch needs at least one piece');

  const barcodes = lines.map(l => l.barcode);
  const pieces = await many<{ id: string; barcode: string; status: string; current_qty: number }>(
    ctx.db,
    `select id, barcode, status, current_qty from piece
      where barcode = any($1::text[]) order by id for update`,
    [barcodes]
  );
  assertAllFound(barcodes, pieces);
  const wrong = pieces.filter(p => p.status !== 'cut_packed' && p.status !== 'received_finish');
  if (wrong.length > 0) {
    throw new Error(`not ready to dispatch: ${wrong.map(p => `${p.barcode} (${p.status})`).join(', ')}`);
  }

  // Credit control, before the truck loads rather than after.
  const cfg = await settings(ctx.db);
  if (boolSetting(cfg, 'credit.enforce_limit', true)) {
    const value = sumBy(lines, l => {
      const p = pieces.find(x => x.barcode === l.barcode);
      return p ? round2(Number(p.current_qty) * l.rate) : 0;
    });
    const breach = await creditBreach(ctx.db, header.partyId, value);
    if (breach) {
      throw new Error(
        `credit limit exceeded: outstanding ${breach.outstanding.toFixed(2)} plus ` +
        `${value.toFixed(2)} would reach ${breach.wouldBe.toFixed(2)} against a ` +
        `limit of ${breach.limit.toFixed(2)}`
      );
    }
  }

  const byBarcode = new Map(pieces.map(p => [p.barcode, p]));
  // Our own outward challan: use the number the user typed, else the series.
  const dispatchNo = header.challanNo?.trim()
    || await nextDocNumber(ctx.db, ctx.tenantId, 'dispatch', ctx.fy);
  const disp = await one<{ id: string }>(
    ctx.db,
    `insert into dispatch (tenant_id, challan_no, challan_date, party_id, transport_id,
                           lr_no, vehicle_no, status, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,'approved',$8) returning id`,
    [ctx.tenantId, dispatchNo, header.challanDate, header.partyId,
     header.transportId ?? null, header.lrNo ?? null, header.vehicleNo ?? null, ctx.userId]
  );
  if (!disp) throw new Error('dispatch insert returned nothing');

  const resolved = lines.map((l, i) => {
    const p = byBarcode.get(l.barcode)!;
    return { ...l, sno: i + 1, pieceId: p.id, qty: p.current_qty, fromStatus: p.status };
  });

  await ctx.db.query(
    `insert into dispatch_line (tenant_id, dispatch_id, so_line_id, piece_id, sno, qty, rate)
     select $1, $2, x.so_line_id, x.piece_id, x.sno, x.qty, x.rate
       from unnest($3::uuid[], $4::uuid[], $5::smallint[], $6::numeric[], $7::numeric[])
            as x(so_line_id, piece_id, sno, qty, rate)`,
    [
      ctx.tenantId, disp.id,
      resolved.map(r => r.soLineId ?? null), resolved.map(r => r.pieceId),
      resolved.map(r => r.sno), resolved.map(r => r.qty), resolved.map(r => r.rate)
    ]
  );

  // received_finish must pass through cut_packed; the transition table forbids the shortcut.
  const direct = resolved.filter(r => r.fromStatus === 'received_finish');
  if (direct.length > 0) {
    await ctx.db.query(
      `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                                   qty_before, qty_after, doc_type, doc_id, created_by)
       select $1, x.piece_id, 'pack', 'received_finish', 'cut_packed', x.qty, x.qty,
              'dispatch', $2, $3
         from unnest($4::uuid[], $5::numeric[]) as x(piece_id, qty)`,
      [ctx.tenantId, disp.id, ctx.userId, direct.map(r => r.pieceId), direct.map(r => r.qty)]
    );
  }

  await ctx.db.query(
    `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                                 qty_before, qty_after, counterparty_id, doc_type, doc_id, created_by)
     select $1, x.piece_id, 'dispatch', 'cut_packed', 'dispatched', x.qty, x.qty,
            $2, 'dispatch', $3, $4
       from unnest($5::uuid[], $6::numeric[]) as x(piece_id, qty)`,
    [
      ctx.tenantId, header.partyId, disp.id, ctx.userId,
      resolved.map(r => r.pieceId), resolved.map(r => r.qty)
    ]
  );

  if (resolved.some(r => r.soLineId)) {
    const withSo = resolved.filter(r => r.soLineId);
    await ctx.db.query(
      `update finish_sales_order_line sl
          set dispatched_qty = sl.dispatched_qty + x.qty
         from unnest($1::uuid[], $2::numeric[]) as x(so_line_id, qty)
        where sl.id = x.so_line_id`,
      [withSo.map(r => r.soLineId), withSo.map(r => r.qty)]
    );
  }

  // A delivery challan moves goods; it does not recognise revenue. That happens
  // once, on the tax invoice raised against this dispatch. It does release the
  // cost of what left, which is the other half of gross margin.
  const value = sumBy(resolved, r => round2(r.qty * r.rate));
  await releaseCostOfSales(ctx, disp.id, header.challanDate, dispatchNo);

  return { id: disp.id, challanNo: dispatchNo, pieces: resolved.length, value: round2(value) };
}

// ----------------------------------------------------------------- helpers --

function assertAllFound(asked: string[], found: { barcode: string }[]) {
  const have = new Set(found.map(f => f.barcode));
  const missing = asked.filter(b => !have.has(b));
  if (missing.length > 0) throw new Error(`unknown or unavailable barcodes: ${missing.join(', ')}`);
  const dupes = asked.filter((b, i) => asked.indexOf(b) !== i);
  if (dupes.length > 0) throw new Error(`barcode listed twice: ${[...new Set(dupes)].join(', ')}`);
}


// ---------------------------------------------------------------- packing --

/**
 * Cut and pack: finish coming back from dyeing is inspected and packed before
 * it can ship. Previously inferred during dispatch, which meant the step left
 * no record of who packed what, or when.
 */
export async function postCutPack(ctx: Ctx, barcodes: string[], note: string) {
  const pieces = await many<{ id: string; barcode: string; status: string; current_qty: number }>(
    ctx.db,
    `select id, barcode, status, current_qty from piece
      where barcode = any($1::text[]) order by id for update`,
    [barcodes]
  );
  assertAllFound(barcodes, pieces);

  const wrong = pieces.filter(p => p.status !== 'received_finish');
  if (wrong.length > 0) {
    throw new Error(
      `only finish back from dyeing can be packed: ${wrong.map(p => `${p.barcode} (${p.status})`).join(', ')}`
    );
  }

  const docId = crypto.randomUUID();
  await ctx.db.query(
    `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                                 qty_before, qty_after, doc_type, doc_id, created_by, note)
     select $1, x.piece_id, 'pack', 'received_finish', 'cut_packed', x.qty, x.qty,
            'cut_pack', $2, $3, $4
       from unnest($5::uuid[], $6::numeric[]) as x(piece_id, qty)`,
    [ctx.tenantId, docId, ctx.userId, note || null,
     pieces.map(p => p.id), pieces.map(p => p.current_qty)]
  );

  return {
    id: docId,
    pieces: pieces.length,
    qty: sumBy(pieces, p => Number(p.current_qty))
  };
}
