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
  activeLocationId?: string;
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
  rateUom?: 'MTR' | 'KGS';
  grossWeightKg?: number | null;
  tareWeightKg?: number | null;
  netWeightKg?: number | null;
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
  for (const line of lines) {
    const supplied = [line.grossWeightKg, line.tareWeightKg, line.netWeightKg]
      .filter(value => value !== null && value !== undefined).length;
    if (supplied > 0 && supplied < 3) {
      throw new Error(`${line.barcode}: gross, tare and net kilograms must be captured together`);
    }
    if (supplied === 3 && Math.abs(
      Number(line.netWeightKg) - (Number(line.grossWeightKg) - Number(line.tareWeightKg))
    ) > 0.005) {
      throw new Error(`${line.barcode}: net kilograms must equal gross minus tare`);
    }
    if (line.rateUom === 'KGS' && !(Number(line.netWeightKg) > 0)) {
      throw new Error(`${line.barcode}: a kilogram rate requires a positive net weight`);
    }
  }

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
                        status, held_by_ledger_id, grey_qty, current_qty, rack_code,
                        grey_weight_kg, current_weight_kg,business_location_id)
     select $1, x.barcode, x.quality_id, x.design_id, x.grade_code, x.lot_no,
            'grey_in_stock', null, x.qty, x.qty, x.rack_code, x.weight_kg, x.weight_kg,
            coalesce((select r.business_location_id from rack_master r
                       where r.tenant_id=$1 and r.code=x.rack_code),$10::uuid)
       from unnest($2::text[], $3::uuid[], $4::uuid[], $5::text[], $6::text[],
                   $7::numeric[], $8::text[], $9::numeric[])
            as x(barcode, quality_id, design_id, grade_code, lot_no, qty, rack_code, weight_kg)
     returning id, barcode`,
    [
      ctx.tenantId,
      lines.map(l => l.barcode),
      lines.map(l => l.qualityId),
      lines.map(l => l.designId ?? null),
      lines.map(l => l.gradeCode),
      lines.map(l => l.lotNo || header.lotNo),
      lines.map(l => l.checkedQty),
      lines.map(l => l.rackCode ?? header.rackCode ?? null),
      lines.map(l => l.netWeightKg ?? null),
      ctx.activeLocationId ?? null
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
                                   received_qty, checked_qty, rate, rate_uom, gross_weight_kg,
                                   tare_weight_kg, net_weight_kg)
     select $1, $2, x.po_line_id, x.piece_id, x.sno, x.received_qty, x.checked_qty, x.rate, x.rate_uom,
            x.gross_weight, x.tare_weight, x.net_weight
       from unnest($3::uuid[], $4::uuid[], $5::smallint[], $6::numeric[], $7::numeric[],
                   $8::numeric[], $9::text[], $10::numeric[], $11::numeric[], $12::numeric[])
            as x(po_line_id, piece_id, sno, received_qty, checked_qty, rate, rate_uom,
                 gross_weight, tare_weight, net_weight)`,
    [
      ctx.tenantId, inward.id,
      lines.map(l => l.poLineId ?? null),
      pieceIds,
      lines.map((_, i) => i + 1),
      lines.map(l => l.receivedQty),
      lines.map(l => l.checkedQty),
      lines.map(l => l.rate),
      lines.map(l => l.rateUom ?? 'MTR'),
      lines.map(l => l.grossWeightKg ?? null),
      lines.map(l => l.tareWeightKg ?? null),
      lines.map(l => l.netWeightKg ?? null)
    ]
  );

  await ctx.db.query(
    `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                                 qty_before, qty_after, weight_before_kg, weight_after_kg,
                                 counterparty_id, doc_type, doc_id, created_by)
     select $1, x.piece_id, 'inward', null, 'grey_in_stock', 0, x.qty, null, x.weight_kg,
            $2, 'grey_inward', $3, $4
       from unnest($5::uuid[], $6::numeric[], $7::numeric[]) as x(piece_id, qty, weight_kg)`,
    [ctx.tenantId, header.partyId, inward.id, ctx.userId, pieceIds,
     lines.map(l => l.checkedQty), lines.map(l => l.netWeightKg ?? null)]
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
  const costOf = (line: InwardLineInput) =>
    (line.rateUom === 'KGS' ? Number(line.netWeightKg) : line.checkedQty) * line.rate;
  const goods = sumBy(lines, l => round2(costOf(l)));
  await capitaliseGrey(
    ctx, inward.id,
    lines.map((l, i) => ({ pieceId: pieceIds[i]!, cost: costOf(l) })),
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

  const pieces = await many<{
    id: string; barcode: string; status: string; current_qty: number; current_weight_kg: number | null;
    quality_id: string; grade_code: string;
  }>(
    ctx.db,
    `select id, barcode, status, current_qty, current_weight_kg, quality_id, grade_code from piece
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
    `insert into dyeing_issue_line (tenant_id, issue_id, piece_id, sno, issued_qty,
                                    issued_weight_kg, job_rate)
     select $1, $2, x.piece_id, x.sno, x.qty, x.weight_kg, $3
       from unnest($4::uuid[], $5::smallint[], $6::numeric[], $7::numeric[])
            as x(piece_id, sno, qty, weight_kg)`,
    [
      ctx.tenantId, issue.id, jobRate,
      pieces.map(p => p.id),
      pieces.map((_, i) => i + 1),
      pieces.map(p => p.current_qty),
      pieces.map(p => p.current_weight_kg)
    ]
  );

  await ctx.db.query(
    `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                                 qty_before, qty_after, weight_before_kg, weight_after_kg,
                                 counterparty_id, doc_type, doc_id, created_by)
     select $1, x.piece_id, 'issue', 'grey_in_stock', 'issued_to_dyeing',
            x.qty, x.qty, x.weight_kg, x.weight_kg, $2, 'dyeing_issue', $3, $4
       from unnest($5::uuid[], $6::numeric[], $7::numeric[]) as x(piece_id, qty, weight_kg)`,
    [
      ctx.tenantId, header.processHouseId, issue.id, ctx.userId,
      pieces.map(p => p.id), pieces.map(p => p.current_qty), pieces.map(p => p.current_weight_kg)
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
  receivedWeightKg?: number | null;
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
    issued_weight_kg: number | null;
  }>(
    ctx.db,
    `select p.id as piece_id, p.barcode, p.status, il.id as issue_line_id, il.issued_qty,
            il.issued_weight_kg
       from piece p
       join dyeing_issue_line il on il.piece_id = p.id
       join dyeing_issue di on di.id = il.issue_id
      where p.barcode = any($1::text[])
        and di.process_house_id = $2
        and not exists (select 1 from dyeing_receipt_line rl
                         where rl.issue_line_id = il.id and rl.active)
      order by p.id
      for update of p, il`,
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
    return { ...l, sno: i + 1, pieceId: r.piece_id, issueLineId: r.issue_line_id,
      issuedQty: r.issued_qty, issuedWeightKg: r.issued_weight_kg };
  });

  await ctx.db.query(
    `insert into dyeing_receipt_line (tenant_id, receipt_id, issue_line_id, piece_id, sno,
                                      issued_qty, received_qty, received_weight_kg,
                                      job_rate, finish_grade)
     select $1, $2, x.issue_line_id, x.piece_id, x.sno, x.issued_qty, x.received_qty,
            x.received_weight, x.job_rate, x.finish_grade
       from unnest($3::uuid[], $4::uuid[], $5::smallint[], $6::numeric[], $7::numeric[],
                   $8::numeric[], $9::numeric[], $10::text[])
            as x(issue_line_id, piece_id, sno, issued_qty, received_qty, received_weight,
                 job_rate, finish_grade)`,
    [
      ctx.tenantId, receipt.id,
      resolved.map(r => r.issueLineId), resolved.map(r => r.pieceId),
      resolved.map(r => r.sno), resolved.map(r => r.issuedQty),
      resolved.map(r => r.receivedQty), resolved.map(r => r.receivedWeightKg ?? null),
      resolved.map(r => r.jobRate),
      resolved.map(r => r.finishGrade)
    ]
  );

  await ctx.db.query(
    `update piece p set finish_qty = x.qty,
                        finish_weight_kg = coalesce(x.weight_kg, p.current_weight_kg),
                        grade_code = x.grade
       from unnest($1::uuid[], $2::numeric[], $3::numeric[], $4::text[])
            as x(piece_id, qty, weight_kg, grade)
      where p.id = x.piece_id`,
    [resolved.map(r => r.pieceId), resolved.map(r => r.receivedQty),
     resolved.map(r => r.receivedWeightKg ?? null), resolved.map(r => r.finishGrade)]
  );

  await ctx.db.query(
    `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                                 qty_before, qty_after, weight_before_kg, weight_after_kg,
                                 counterparty_id, doc_type, doc_id, created_by)
     select $1, x.piece_id, 'receipt', 'issued_to_dyeing', 'received_finish',
            x.before_qty, x.after_qty, x.before_weight, coalesce(x.after_weight, x.before_weight),
            null, 'dyeing_receipt', $2, $3
       from unnest($4::uuid[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[])
            as x(piece_id, before_qty, after_qty, before_weight, after_weight)`,
    [
      ctx.tenantId, receipt.id, ctx.userId,
      resolved.map(r => r.pieceId), resolved.map(r => r.issuedQty), resolved.map(r => r.receivedQty),
      resolved.map(r => r.issuedWeightKg), resolved.map(r => r.receivedWeightKg ?? null)
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
  /** `baleNo` is what the customer's storekeeper reads when they cut the strap. */
  lines: { barcode: string; rate: number; soLineId?: string | null; baleNo?: number | null }[]
) {
  if (lines.length === 0) throw new Error('a dispatch needs at least one piece');

  const barcodes = lines.map(l => l.barcode);
  const pieces = await many<{
    id: string; barcode: string; status: string; current_qty: number;
    quality_id: string; grade_code: string;
  }>(
    ctx.db,
    `select id, barcode, status, current_qty, quality_id, grade_code from piece
      where barcode = any($1::text[]) order by id for update`,
    [barcodes]
  );
  assertAllFound(barcodes, pieces);
  const wrong = pieces.filter(p => p.status !== 'cut_packed' && p.status !== 'received_finish');
  if (wrong.length > 0) {
    throw new Error(`not ready to dispatch: ${wrong.map(p => `${p.barcode} (${p.status})`).join(', ')}`);
  }

  const byBarcode = new Map(pieces.map(p => [p.barcode, p]));
  const soIds = [...new Set(lines.flatMap(line => line.soLineId ? [line.soLineId] : []))];
  if (soIds.length > 0) {
    const orderLines = await many<{
      id: string; party_id: string; order_no: string; status: string;
      quality_id: string; grade_code: string; qty: number; dispatched_qty: number;
    }>(ctx.db,
      `select sl.id, so.party_id, so.order_no, so.status::text, sl.quality_id,
              sl.grade_code, sl.qty, sl.dispatched_qty
         from finish_sales_order_line sl
         join finish_sales_order so on so.id = sl.order_id
        where sl.id = any($1::uuid[]) order by sl.id for update of sl`, [soIds]);
    if (orderLines.length !== soIds.length) throw new Error('one or more sales-order lines do not exist');
    const orderById = new Map(orderLines.map(line => [line.id, line]));
    const allocated = new Map<string, number>();
    for (const line of lines) {
      if (!line.soLineId) continue;
      const orderLine = orderById.get(line.soLineId)!;
      const piece = byBarcode.get(line.barcode)!;
      if (orderLine.party_id !== header.partyId) {
        throw new Error(`${orderLine.order_no} belongs to a different customer`);
      }
      if (!['approved', 'partly_done'].includes(orderLine.status)) {
        throw new Error(`${orderLine.order_no} is ${orderLine.status}`);
      }
      if (orderLine.quality_id !== piece.quality_id || orderLine.grade_code !== piece.grade_code) {
        throw new Error(
          `${line.barcode} quality/grade ${piece.quality_id}/${piece.grade_code} does not match ` +
          `${orderLine.order_no} line ${orderLine.quality_id}/${orderLine.grade_code}`
        );
      }
      allocated.set(line.soLineId, (allocated.get(line.soLineId) ?? 0) + Number(piece.current_qty));
    }
    for (const [lineId, qty] of allocated) {
      const orderLine = orderById.get(lineId)!;
      const balance = Number(orderLine.qty) - Number(orderLine.dispatched_qty);
      if (qty > balance + 0.005) {
        throw new Error(`${orderLine.order_no} has only ${balance.toFixed(2)} remaining on that line`);
      }
    }
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
    `insert into dispatch_line (tenant_id, dispatch_id, so_line_id, piece_id, sno, qty, rate, bale_no)
     select $1, $2, x.so_line_id, x.piece_id, x.sno, x.qty, x.rate, x.bale_no
       from unnest($3::uuid[], $4::uuid[], $5::smallint[], $6::numeric[], $7::numeric[], $8::smallint[])
            as x(so_line_id, piece_id, sno, qty, rate, bale_no)`,
    [
      ctx.tenantId, disp.id,
      resolved.map(r => r.soLineId ?? null), resolved.map(r => r.pieceId),
      resolved.map(r => r.sno), resolved.map(r => r.qty), resolved.map(r => r.rate),
      resolved.map(r => r.baleNo ?? null)
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
         from (select so_line_id, sum(qty) as qty
                 from unnest($1::uuid[], $2::numeric[]) as raw(so_line_id, qty)
                group by so_line_id) x
        where sl.id = x.so_line_id`,
      [withSo.map(r => r.soLineId), withSo.map(r => r.qty)]
    );
    await ctx.db.query(
      `update finish_sales_order so
          set status = case
            when not exists (select 1 from finish_sales_order_line sl
                              where sl.order_id = so.id and sl.dispatched_qty < sl.qty)
              then 'closed'::doc_status
            else 'partly_done'::doc_status
          end
        where so.id in (select distinct order_id from finish_sales_order_line
                         where id = any($1::uuid[]))`,
      [withSo.map(r => r.soLineId)]
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
