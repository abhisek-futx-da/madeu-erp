import { many, one, nextDocNumber } from './db.ts';
import type { Ctx } from './domain.ts';
import { apportion, round2, sameMoney, sumBy, sumMoney } from './money.ts';
import { postVoucher, roleLedgers } from './payments.ts';

/**
 * Cutting a thaan in two, and putting short ends back together.
 *
 * The spine could only move a piece whole, so the day an operator cut a 118 m
 * roll to ship 70 m, the other 48 m left the system. Both halves are pieces
 * now: the original is `consumed`, its children carry its cost apportioned by
 * length, and `piece_lineage` says which became which.
 *
 * Two rules hold, the same two the rest of the domain holds:
 *  - a piece never changes status by UPDATE; it changes by inserting a movement
 *  - nothing is queried per line; every statement is batched over the whole set
 */

/** A thaan is ours to cut only while it is in our own custody. */
const CUTTABLE = ['grey_in_stock', 'received_finish', 'cut_packed'];

interface PieceRow {
  id: string; barcode: string; status: string; current_qty: number;
  quality_id: string; design_id: string | null; grade_code: string;
  lot_no: string; uom: string; grey_qty: number; finish_qty: number | null;
  grey_cost: number; jobwork_cost: number; other_cost: number; cost_posted: boolean;
}

const COST_FIELDS = ['grey_cost', 'jobwork_cost', 'other_cost'] as const;
type CostField = (typeof COST_FIELDS)[number];
type Costs = Record<CostField, number>;

const SELECT_PIECE = `select p.id, p.barcode, p.status::text, p.current_qty, p.quality_id,
                             p.design_id, p.grade_code, p.lot_no, p.uom,
                             p.grey_qty, p.finish_qty,
                             p.grey_cost, p.jobwork_cost, p.other_cost, p.cost_posted
                        from piece p`;

function assertCuttable(pieces: PieceRow[]) {
  const held = pieces.filter(p => !CUTTABLE.includes(p.status));
  if (held.length > 0) {
    throw new Error(
      `only goods in our own custody can be regrouped: ${
        held.map(p => `${p.barcode} is ${p.status.replace(/_/g, ' ')}`).join(', ')}`
    );
  }
  const sold = pieces.filter(p => p.cost_posted);
  if (sold.length > 0) {
    throw new Error(`cost has already been released to sales for ${sold.map(p => p.barcode).join(', ')}`);
  }
}

/** Header plus the movements and lineage every regroup writes, in one place. */
async function writeRegroup(
  ctx: Ctx,
  kind: 'split' | 'merge',
  entryDate: string,
  reason: string,
  consumed: { pieceId: string; status: string; qty: number }[],
  produced: { pieceId: string; status: string; qty: number }[],
  lineage: { parentId: string; childId: string; qty: number; costs: Costs }[],
  loss?: { qty: number; grey: number; jobwork: number; other: number }
) {
  const entryNo = await nextDocNumber(ctx.db, ctx.tenantId, 'piece_regroup', ctx.fy);
  const header = await one<{ id: string }>(
    ctx.db,
    `insert into piece_regroup (tenant_id, entry_no, entry_date, kind, reason, created_by, loss_qty, loss_grey, loss_jobwork, loss_other)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [ctx.tenantId, entryNo, entryDate, kind, reason, ctx.userId, loss?.qty ?? 0, loss?.grey ?? 0, loss?.jobwork ?? 0, loss?.other ?? 0]
  );
  if (!header) throw new Error('regroup insert returned nothing');

  await ctx.db.query(
    `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                                 qty_before, qty_after, doc_type, doc_id, created_by, note)
     select $1, x.piece_id, $2::movement_event, null, x.status::piece_status, 0, x.qty,
            'piece_regroup', $3, $4, $5
       from unnest($6::uuid[], $7::text[], $8::numeric[]) as x(piece_id, status, qty)`,
    [ctx.tenantId, kind, header.id, ctx.userId, reason || null,
     produced.map(p => p.pieceId), produced.map(p => p.status), produced.map(p => p.qty)]
  );

  await ctx.db.query(
    `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                                 qty_before, qty_after, doc_type, doc_id, created_by, note)
     select $1, x.piece_id, $2::movement_event, x.status::piece_status, 'consumed', x.qty, 0,
            'piece_regroup', $3, $4, $5
       from unnest($6::uuid[], $7::text[], $8::numeric[]) as x(piece_id, status, qty)`,
    [ctx.tenantId, kind, header.id, ctx.userId, reason || null,
     consumed.map(p => p.pieceId), consumed.map(p => p.status), consumed.map(p => p.qty)]
  );

  await ctx.db.query(
    `insert into piece_lineage (tenant_id, regroup_id, parent_id, child_id, qty,
                                grey_cost, jobwork_cost, other_cost)
     select $1, $2, x.parent_id, x.child_id, x.qty, x.grey, x.jobwork, x.other
       from unnest($3::uuid[], $4::uuid[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[])
            as x(parent_id, child_id, qty, grey, jobwork, other)`,
    [
      ctx.tenantId, header.id,
      lineage.map(l => l.parentId), lineage.map(l => l.childId), lineage.map(l => l.qty),
      lineage.map(l => l.costs.grey_cost), lineage.map(l => l.costs.jobwork_cost),
      lineage.map(l => l.costs.other_cost)
    ]
  );

  return { id: header.id, entryNo };
}

// ------------------------------------------------------------------ split --

export interface SplitChildInput {
  /** Defaults to the parent barcode with a `-1`, `-2` suffix, as a mill does. */
  barcode?: string;
  qty: number;
}

/**
 * One thaan becomes several. The children's lengths must add up to the
 * parent's exactly: a cutting loss is a stock loss and belongs in a write-off
 * where a CA can see it, not silently capitalised into whatever is left.
 */
export async function splitPiece(
  ctx: Ctx,
  input: { barcode: string; entryDate: string; reason: string; children: SplitChildInput[]; lossQty?: number }
) {
  if (input.children.length < 2 && !(input.children.length === 1 && input.lossQty)) throw new Error('a split needs at least two pieces (or one piece and a loss)');
  if (input.children.some(c => !(c.qty > 0))) throw new Error('every piece must have a length');

  const parent = await one<PieceRow>(
    ctx.db, `${SELECT_PIECE} where p.barcode = $1 for update`, [input.barcode]
  );
  if (!parent) throw new Error(`unknown barcode: ${input.barcode}`);
  assertCuttable([parent]);

  const asked = round2(sumBy(input.children, c => c.qty) + (input.lossQty ?? 0));
  const have = Number(parent.current_qty);
  if (!sameMoney(asked, have)) {
    throw new Error(
      `the pieces add up to ${asked} ${parent.uom} but ${parent.barcode} holds ${have} ` +
      `— add the offcut as its own piece, or write the shortage off first`
    );
  }

  // A cancelled split leaves its children behind as consumed rows, and a
  // barcode is never reused — so the suffix has to continue past whatever this
  // thaan has already been cut into, not restart at 1.
  const taken = await one<{ highest: number }>(
    ctx.db,
    `select coalesce(max(nullif(regexp_replace(barcode, '^.*-', ''), '')::bigint), 0) as highest
       from piece
      where barcode like $1 || '-%'
        and barcode ~ ('^' || $2 || '-[0-9]+$')`,
    [parent.barcode, parent.barcode.replace(/[.^$*+?()[\]{}|\\]/g, '\\$&')]
  );
  let next = Number(taken?.highest ?? 0);
  const barcodes = input.children.map(c => c.barcode?.trim() || `${parent.barcode}-${++next}`);

  if (new Set(barcodes).size !== barcodes.length) {
    throw new Error('the new barcodes must all differ');
  }
  const clash = await many<{ barcode: string }>(
    ctx.db, 'select barcode from piece where barcode = any($1::text[])', [barcodes]
  );
  if (clash.length > 0) {
    throw new Error(`barcode already in use: ${clash.map(c => c.barcode).join(', ')}`);
  }

  const qtys = input.children.map(c => c.qty);
  if (input.lossQty) qtys.push(input.lossQty);
  const shares = Object.fromEntries(
    COST_FIELDS.map(f => [f, apportion(Number(parent[f]), qtys)])
  ) as Record<CostField, number[]>;

  // Grey and finish lengths divide the same way the cost does. A piece back
  // from dyeing is shorter than the grey it started as, so the two cannot be
  // collapsed into one number: shrinkage per child has to stay readable.
  const greyQtys = apportion(Number(parent.grey_qty), qtys);
  const finish = parent.finish_qty === null ? null : apportion(Number(parent.finish_qty), qtys);

  const hasLoss = (input.lossQty ?? 0) > 0;
  const lossCost = hasLoss
    ? sumMoney([shares.grey_cost[qtys.length - 1]!, shares.jobwork_cost[qtys.length - 1]!, shares.other_cost[qtys.length - 1]!])
    : 0;

  const children = await many<{ id: string; barcode: string }>(
    ctx.db,
    `insert into piece (tenant_id, barcode, quality_id, design_id, grade_code, lot_no,
                        status, grey_qty, finish_qty, current_qty, uom,
                        grey_cost, jobwork_cost, other_cost)
     select $1, x.barcode, $2, $3, $4, $5, $6::piece_status, x.grey_qty, x.finish, x.qty, $7,
            x.grey, x.jobwork, x.other
       from unnest($8::text[], $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[],
                   $13::numeric[], $14::numeric[])
            as x(barcode, qty, grey_qty, finish, grey, jobwork, other)
     returning id, barcode`,
    [
      ctx.tenantId, parent.quality_id, parent.design_id, parent.grade_code, parent.lot_no,
      parent.status, parent.uom,
      barcodes, qtys.slice(0, barcodes.length), greyQtys.slice(0, barcodes.length), finish?.slice(0, barcodes.length) ?? null, shares.grey_cost.slice(0, barcodes.length), shares.jobwork_cost.slice(0, barcodes.length), shares.other_cost.slice(0, barcodes.length)
    ]
  );
  const idOf = new Map(children.map(c => [c.barcode, c.id]));

  // The cost left with the children; leaving it on the parent too would value
  // the same rupees twice in any total taken across every piece.
  await ctx.db.query(
    'update piece set grey_cost = 0, jobwork_cost = 0, other_cost = 0 where id = $1',
    [parent.id]
  );

  const doc = await writeRegroup(
    ctx, 'split', input.entryDate, input.reason,
    [{ pieceId: parent.id, status: parent.status, qty: have }],
    barcodes.map((b, i) => ({ pieceId: idOf.get(b)!, status: parent.status, qty: qtys[i]! })),
    barcodes.map((b, i) => ({
      parentId: parent.id,
      childId: idOf.get(b)!,
      qty: qtys[i]!,
      costs: {
        grey_cost: shares.grey_cost[i]!,
        jobwork_cost: shares.jobwork_cost[i]!,
        other_cost: shares.other_cost[i]!
      }
    })),
    hasLoss ? { qty: input.lossQty!, grey: shares.grey_cost[qtys.length - 1]!, jobwork: shares.jobwork_cost[qtys.length - 1]!, other: shares.other_cost[qtys.length - 1]! } : undefined
  );

  if (hasLoss && lossCost > 0) {
    const led = await roleLedgers(ctx.db);
    const inventory = parent.status === 'grey_in_stock' ? 'inventory_grey' : 'inventory_finish';
    await postVoucher(
      ctx, 'journal', input.entryDate,
      `Cutting loss for ${parent.barcode}`,
      'piece_regroup', doc.id,
      [
        { ledgerId: led.get('stock_loss')!, debit: lossCost },
        { ledgerId: led.get(inventory)!, credit: lossCost }
      ]
    );
  }

  return {
    ...doc,
    kind: 'split' as const,
    from: parent.barcode,
    qty: round2(have),
    lossQty: input.lossQty || 0,
    lossCost,
    pieces: barcodes.map((barcode, i) => ({
      barcode,
      qty: qtys[i]!,
      cost: sumMoney([shares.grey_cost[i]!, shares.jobwork_cost[i]!, shares.other_cost[i]!])
    }))
  };
}

// ------------------------------------------------------------------ merge --

/**
 * Short ends of the same quality, grade and lot become one piece again. Only
 * pieces a buyer would accept as interchangeable may merge: differ on any of
 * those and the merged roll would misdescribe itself on an invoice.
 */
export async function mergePieces(
  ctx: Ctx,
  input: { barcodes: string[]; intoBarcode: string; entryDate: string; reason: string }
) {
  const asked = input.barcodes.map(b => b.trim()).filter(Boolean);
  if (asked.length < 2) throw new Error('a merge needs at least two pieces');
  if (new Set(asked).size !== asked.length) throw new Error('a piece is listed twice');

  const parents = await many<PieceRow>(
    ctx.db, `${SELECT_PIECE} where p.barcode = any($1::text[]) order by p.id for update`, [asked]
  );
  const missing = asked.filter(b => !parents.some(p => p.barcode === b));
  if (missing.length > 0) throw new Error(`unknown barcodes: ${missing.join(', ')}`);
  assertCuttable(parents);

  const [first, ...rest] = parents as [PieceRow, ...PieceRow[]];
  const differs = (p: PieceRow) =>
    p.quality_id !== first.quality_id || p.design_id !== first.design_id ||
    p.grade_code !== first.grade_code || p.lot_no !== first.lot_no ||
    p.uom !== first.uom || p.status !== first.status;
  const odd = rest.filter(differs);
  if (odd.length > 0) {
    throw new Error(
      `only pieces of the same quality, design, grade, lot and state can merge: ` +
      `${odd.map(p => p.barcode).join(', ')} differ from ${first.barcode}`
    );
  }

  const intoBarcode = input.intoBarcode.trim();
  if (!intoBarcode) throw new Error('the merged piece needs a barcode');
  const clash = await one<{ barcode: string }>(
    ctx.db, 'select barcode from piece where barcode = $1', [intoBarcode]
  );
  if (clash) throw new Error(`barcode already in use: ${intoBarcode}`);

  const qty = sumBy(parents, p => Number(p.current_qty));
  const greyQty = sumBy(parents, p => Number(p.grey_qty));
  const costs = Object.fromEntries(
    COST_FIELDS.map(f => [f, sumBy(parents, p => Number(p[f]))])
  ) as Costs;
  // Grey stock has no finish length; a mixed set cannot happen, the state check
  // above already forced every parent into the same status.
  const finish = parents.every(p => p.finish_qty === null)
    ? null
    : sumBy(parents, p => Number(p.finish_qty ?? 0));

  const child = await one<{ id: string }>(
    ctx.db,
    `insert into piece (tenant_id, barcode, quality_id, design_id, grade_code, lot_no,
                        status, grey_qty, finish_qty, current_qty, uom,
                        grey_cost, jobwork_cost, other_cost)
     values ($1,$2,$3,$4,$5,$6,$7::piece_status,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [
      ctx.tenantId, intoBarcode, first.quality_id, first.design_id, first.grade_code,
      first.lot_no, first.status, greyQty, finish, qty, first.uom,
      costs.grey_cost, costs.jobwork_cost, costs.other_cost
    ]
  );
  if (!child) throw new Error('merged piece insert returned nothing');

  await ctx.db.query(
    'update piece set grey_cost = 0, jobwork_cost = 0, other_cost = 0 where id = any($1::uuid[])',
    [parents.map(p => p.id)]
  );

  const doc = await writeRegroup(
    ctx, 'merge', input.entryDate, input.reason,
    parents.map(p => ({ pieceId: p.id, status: p.status, qty: Number(p.current_qty) })),
    [{ pieceId: child.id, status: first.status, qty }],
    parents.map(p => ({
      parentId: p.id,
      childId: child.id,
      qty: Number(p.current_qty),
      costs: {
        grey_cost: Number(p.grey_cost),
        jobwork_cost: Number(p.jobwork_cost),
        other_cost: Number(p.other_cost)
      }
    }))
  );

  return {
    ...doc,
    kind: 'merge' as const,
    into: intoBarcode,
    qty: round2(qty),
    from: parents.map(p => ({ barcode: p.barcode, qty: Number(p.current_qty) }))
  };
}

// ---------------------------------------------------------------- lineage --

/** Everything a barcode was cut from, and everything it was cut into. */
export async function lineageOf(ctx: Ctx, barcode: string) {
  return many(
    ctx.db,
    `select * from v_piece_lineage
      where from_barcode = $1 or to_barcode = $1
      order by entry_date, entry_no`,
    [barcode]
  );
}
