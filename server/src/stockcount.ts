import { many, one, nextDocNumber } from './db.ts';
import type { Ctx } from './domain.ts';
import { roleLedgers } from './valuation.ts';
import { holdVoucher, recordEvent, approvalFor } from './approvals.ts';
import { round2, sumBy } from './money.ts';

/**
 * Physical stock count and variance approval.
 *
 * The movement log says the rack holds a hundred and eighteen metres. Nothing
 * in this system ever walked to the rack and checked, so a discrepancy was
 * invisible until someone tripped over it — and the only cure was an UPDATE.
 *
 * A count freezes what the system believes, records what was scanned, names
 * every disagreement, makes a person choose an outcome and give a reason,
 * makes a second person approve it, and only then moves stock and rupees.
 * There is deliberately no "adjust stock" call anywhere in this file: the
 * outcomes below are the complete list of things a count may do.
 */

/** Goods at a process house are theirs to count, not ours. */
const COUNTABLE = ['grey_in_stock', 'received_finish', 'cut_packed'];

export type VarianceKind =
  | 'missing' | 'extra' | 'short' | 'excess' | 'wrong_rack' | 'duplicate_scan';

export type Outcome =
  | 'write_off' | 'adjust_qty' | 'relocate'
  | 'accept_system' | 'needs_inward' | 'investigate';

/**
 * Which answers each kind of disagreement will accept. A missing piece cannot
 * be "relocated", and no exception may be resolved by inventing stock: an
 * unknown barcode has no quality, no cost and no supplier, so the only honest
 * outcome is to say so and book it through a proper inward.
 */
const LEGAL: Record<VarianceKind, Outcome[]> = {
  missing:        ['write_off', 'accept_system', 'investigate'],
  extra:          ['relocate', 'needs_inward', 'accept_system', 'investigate'],
  short:          ['adjust_qty', 'accept_system', 'investigate'],
  excess:         ['adjust_qty', 'accept_system', 'investigate'],
  wrong_rack:     ['relocate', 'accept_system', 'investigate'],
  duplicate_scan: ['accept_system', 'investigate']
};

/** Outcomes that move stock or rupees; the rest are recorded and nothing more. */
const ACTS = new Set<Outcome>(['write_off', 'adjust_qty', 'relocate']);

export interface Scope {
  rackCode?: string | null;
  qualityId?: string | null;
  lotNo?: string | null;
  /** One thaan: a floor re-measure rather than a rack. */
  barcode?: string | null;
}

interface ExceptionRow {
  barcode: string;
  piece_id: string | null;
  kind: VarianceKind;
  system_qty: number | null;
  counted_qty: number | null;
  system_rack: string | null;
  counted_rack: string | null;
  value: number;
}

const SCOPE_SQL = `($2::text is null or p.rack_code = $2)
                   and ($3::uuid is null or p.quality_id = $3)
                   and ($4::text is null or p.lot_no = $4)
                   and ($5::text is null or p.barcode = $5)`;

// ------------------------------------------------------------------- open --

/**
 * Opens a sheet and freezes the system's answer. Frozen, because a count
 * measured against a moving system proves nothing: goods dispatched while the
 * counter walks the aisle would read as missing.
 */
export async function openCount(
  ctx: Ctx, input: Scope & { countDate: string; reason: string }
) {
  const scope = [input.rackCode ?? null, input.qualityId ?? null, input.lotNo ?? null,
                 input.barcode ?? null];

  // Two open sheets over one shelf would each write the other's pieces off.
  const clash = await one<{ count_no: string; barcode: string }>(
    ctx.db,
    `select c.count_no, e.barcode
       from stock_count_expected e
       join stock_count c on c.id = e.count_id
       join piece p on p.id = e.piece_id
      where c.status in ('draft', 'pending_approval')
        and p.status::text = any($1::text[]) and ${SCOPE_SQL}
      limit 1`,
    [COUNTABLE, ...scope]
  );
  if (clash) {
    throw new Error(
      `${clash.count_no} is still open over this stock (${clash.barcode}); finish it first`
    );
  }

  const countNo = await nextDocNumber(ctx.db, ctx.tenantId, 'stock_count', ctx.fy);
  const count = await one<{ id: string }>(
    ctx.db,
    `insert into stock_count (tenant_id, count_no, count_date, rack_code, quality_id,
                              lot_no, reason, created_by, barcode)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [ctx.tenantId, countNo, input.countDate, input.rackCode ?? null,
     input.qualityId ?? null, input.lotNo ?? null, input.reason, ctx.userId,
     input.barcode ?? null]
  );
  if (!count) throw new Error('stock count insert returned nothing');

  const frozen = await one<{ n: number }>(
    ctx.db,
    `with snap as (
       insert into stock_count_expected (tenant_id, count_id, piece_id, barcode,
                                         status, rack_code, qty, cost)
       select $1, $6, p.id, p.barcode, p.status, p.rack_code, p.current_qty,
              p.grey_cost + p.jobwork_cost + p.other_cost
         from piece p
        where p.status::text = any($7::text[]) and ${SCOPE_SQL}
       returning 1
     )
     select count(*)::int as n from snap`,
    [ctx.tenantId, ...scope, count.id, COUNTABLE]
  );

  const pieces = frozen?.n ?? 0;
  if (pieces === 0) throw new Error('nothing in stock matches that scope');
  await ctx.db.query(
    'update stock_count set pieces_expected = $2 where id = $1', [count.id, pieces]
  );

  return { id: count.id, countNo, countDate: input.countDate, piecesExpected: pieces };
}

// ------------------------------------------------------------------ scans --

export interface ScanInput { barcode: string; rackCode?: string | null; qty?: number | null; note?: string }

async function openSheet(ctx: Ctx, countId: string) {
  const c = await one<{ count_no: string; status: string }>(
    ctx.db, 'select count_no, status from stock_count where id = $1 for update', [countId]
  );
  if (!c) throw new Error('stock count not found');
  if (c.status !== 'draft') throw new Error(`${c.count_no} is ${c.status} and no longer open`);
  return c;
}

/** A batch, because a phone off the network posts its whole queue at once. */
export async function addScans(ctx: Ctx, countId: string, scans: ScanInput[]) {
  const sheet = await openSheet(ctx, countId);
  const clean = scans
    .map(s => ({ ...s, barcode: s.barcode.trim() }))
    .filter(s => s.barcode.length > 0);
  if (clean.length === 0) throw new Error('nothing to record');

  await ctx.db.query(
    `insert into stock_count_scan (tenant_id, count_id, barcode, rack_code, qty, note, scanned_by)
     select $1, $2, x.barcode, x.rack_code, x.qty, x.note, $3
       from unnest($4::text[], $5::text[], $6::numeric[], $7::text[])
            as x(barcode, rack_code, qty, note)`,
    [ctx.tenantId, countId, ctx.userId,
     clean.map(s => s.barcode), clean.map(s => s.rackCode ?? null),
     clean.map(s => s.qty ?? null), clean.map(s => s.note ?? null)]
  );

  return { countNo: sheet.count_no, recorded: clean.length };
}

/** A mis-scan is correctable while the sheet is open; the trigger stops it later. */
export async function removeScan(ctx: Ctx, countId: string, scanId: number) {
  await openSheet(ctx, countId);
  const gone = await ctx.db.query(
    'delete from stock_count_scan where count_id = $1 and id = $2', [countId, scanId]
  );
  if (gone.rowCount === 0) throw new Error('no such scan on this sheet');
  return { removed: scanId };
}

export async function exceptionsFor(ctx: Ctx, countId: string) {
  return many<ExceptionRow>(
    ctx.db,
    `select barcode, piece_id, kind::text as kind, system_qty, counted_qty,
            system_rack, counted_rack, value
       from v_stock_count_exception where count_id = $1
      order by kind, barcode`,
    [countId]
  );
}

// ----------------------------------------------------------------- submit --

export interface Decision {
  barcode: string;
  kind: VarianceKind;
  outcome: Outcome;
  reason: string;
}

/**
 * Freezes the operator's answers and holds the accounting entry. Every
 * exception has to be answered: a sheet submitted with anything unresolved
 * would leave the approver agreeing to a number nobody had explained.
 */
export async function submitCount(ctx: Ctx, countId: string, decisions: Decision[]) {
  const sheet = await openSheet(ctx, countId);
  const exceptions = await exceptionsFor(ctx, countId);

  const key = (b: string, k: string) => `${b} ${k}`;
  const chosen = new Map(decisions.map(d => [key(d.barcode.trim(), d.kind), d]));

  const unanswered = exceptions.filter(e => !chosen.has(key(e.barcode, e.kind)));
  if (unanswered.length > 0) {
    throw new Error(
      `every difference needs an answer; ${unanswered.length} left: ` +
      unanswered.slice(0, 5).map(e => `${e.barcode} (${e.kind})`).join(', ')
    );
  }

  const resolved = exceptions.map(e => {
    const d = chosen.get(key(e.barcode, e.kind))!;
    if (!LEGAL[e.kind].includes(d.outcome)) {
      throw new Error(
        `${e.barcode}: a ${e.kind.replace(/_/g, ' ')} cannot be answered with ` +
        `"${d.outcome.replace(/_/g, ' ')}" — try ${LEGAL[e.kind].join(', ')}`
      );
    }
    if (!d.reason.trim()) throw new Error(`${e.barcode}: a reason is required`);
    // A barcode the system has never seen has no quality, no cost and no
    // supplier. It gets booked in properly or not at all.
    if (d.outcome === 'needs_inward' && e.piece_id) {
      throw new Error(`${e.barcode} is already a known piece; book it in place, not as new stock`);
    }
    if (d.outcome !== 'needs_inward' && d.outcome !== 'investigate' && !e.piece_id) {
      throw new Error(`${e.barcode} is unknown to the system; the only outcome is needs_inward`);
    }
    if (d.outcome === 'relocate' && !e.counted_rack) {
      throw new Error(`${e.barcode} was scanned without a rack, so it cannot be relocated`);
    }
    return { e, d, value: ACTS.has(d.outcome) ? round2(Number(e.value)) : 0 };
  });

  await ctx.db.query(
    `insert into stock_count_variance (tenant_id, count_id, piece_id, barcode, kind, outcome,
                                       system_qty, counted_qty, system_rack, counted_rack,
                                       value, reason)
     select $1, $2, x.piece_id, x.barcode, x.kind::count_variance_kind,
            x.outcome::count_outcome, x.system_qty, x.counted_qty, x.system_rack,
            x.counted_rack, x.value, x.reason
       from unnest($3::uuid[], $4::text[], $5::text[], $6::text[], $7::numeric[],
                   $8::numeric[], $9::text[], $10::text[], $11::numeric[], $12::text[])
            as x(piece_id, barcode, kind, outcome, system_qty, counted_qty,
                 system_rack, counted_rack, value, reason)`,
    [
      ctx.tenantId, countId,
      resolved.map(r => r.e.piece_id), resolved.map(r => r.e.barcode),
      resolved.map(r => r.e.kind), resolved.map(r => r.d.outcome),
      resolved.map(r => r.e.system_qty), resolved.map(r => r.e.counted_qty),
      resolved.map(r => r.e.system_rack), resolved.map(r => r.e.counted_rack),
      resolved.map(r => r.value), resolved.map(r => r.d.reason.trim())
    ]
  );

  const net = sumBy(resolved, r => r.value);
  await ctx.db.query(
    `update stock_count set net_value = $2, status = 'pending_approval',
                            submitted_at = now() where id = $1`,
    [countId, net]
  );

  if (net !== 0) await holdCountVoucher(ctx, countId, sheet.count_no, net);
  await recordEvent(ctx, 'stock_count', countId, 'submitted', net, sheet.count_no);

  const rule = await approvalFor(ctx.db, 'stock_count', Math.abs(net));
  return {
    id: countId, countNo: sheet.count_no, status: 'pending_approval',
    variances: resolved.length,
    netValue: net,
    awaiting: rule?.role ?? 'owner'
  };
}

/**
 * The entry a count would make. Grey and finish are separate inventory
 * accounts, so a shortage is credited to whichever the piece was sitting in;
 * loss and gain are separate P&L lines because netting them hides the figure
 * an owner actually wants.
 */
async function holdCountVoucher(ctx: Ctx, countId: string, countNo: string, net: number) {
  const bands = await many<{ status: string; value: number }>(
    ctx.db,
    `select e.status::text as status, sum(v.value) as value
       from stock_count_variance v
       join stock_count_expected e on e.count_id = v.count_id and e.piece_id = v.piece_id
      where v.count_id = $1 and v.value <> 0
      group by e.status`,
    [countId]
  );

  const led = await roleLedgers(ctx.db);
  const postings: { ledgerId: string; debit?: number; credit?: number }[] = [];
  for (const band of bands) {
    const value = round2(Number(band.value));
    if (value === 0) continue;
    const inventory = band.status === 'grey_in_stock' ? 'inventory_grey' : 'inventory_finish';
    postings.push(value < 0
      ? { ledgerId: led.need(inventory), credit: -value }
      : { ledgerId: led.need(inventory), debit: value });
  }
  postings.push(net < 0
    ? { ledgerId: led.need('stock_loss'), debit: -net }
    : { ledgerId: led.need('stock_gain'), credit: net });

  const date = await one<{ d: string }>(
    ctx.db, 'select count_date::text as d from stock_count where id = $1', [countId]
  );
  await holdVoucher(
    ctx, 'stock_count', countId, 'journal', date!.d,
    `Physical verification ${countNo}`, postings
  );
}

// ------------------------------------------------------------------ apply --

/**
 * Runs when a second person approves. Every movement goes through the same
 * append-only log every other document uses, so a count is as auditable as a
 * dispatch and as reversible.
 */
export async function applyStockCount(ctx: Ctx, countId: string) {
  const rows = await many<{
    piece_id: string; barcode: string; outcome: Outcome;
    counted_qty: number | null; counted_rack: string | null; value: number;
    expected_qty: number; expected_status: string;
    live_qty: number; live_status: string; live_rack: string | null;
  }>(
    ctx.db,
    `select v.piece_id, v.barcode, v.outcome::text as outcome, v.counted_qty,
            v.counted_rack, v.value, e.qty as expected_qty, e.status::text as expected_status,
            p.current_qty as live_qty, p.status::text as live_status, p.rack_code as live_rack
       from stock_count_variance v
       join piece p on p.id = v.piece_id
       join stock_count_expected e on e.count_id = v.count_id and e.piece_id = v.piece_id
      where v.count_id = $1 and v.outcome::text = any($2::text[])
      order by p.id
        for update of p`,
    [countId, [...ACTS]]
  );
  if (rows.length === 0) return { moved: 0 };

  // The snapshot was frozen when the sheet opened. If a piece has moved since,
  // acting on the old picture would post a correction against goods that are
  // no longer there.
  const stale = rows.filter(
    r => r.live_status !== r.expected_status || Number(r.live_qty) !== Number(r.expected_qty)
  );
  if (stale.length > 0) {
    throw new Error(
      `${stale.length} piece(s) have moved since the count was taken ` +
      `(${stale.slice(0, 3).map(r => r.barcode).join(', ')}); count them again`
    );
  }

  const move = (r: typeof rows[number]) => {
    if (r.outcome === 'write_off') {
      return { to: 'written_off', qty: 0, rack: null as string | null };
    }
    if (r.outcome === 'adjust_qty') {
      return { to: r.live_status, qty: Number(r.counted_qty), rack: null };
    }
    return { to: r.live_status, qty: Number(r.live_qty), rack: r.counted_rack };
  };
  const moves = rows.map(r => ({ r, m: move(r) }));

  await ctx.db.query(
    `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                                 qty_before, qty_after, to_rack, from_rack,
                                 doc_type, doc_id, created_by, note)
     select $1, x.piece_id, 'adjust', x.from_status::piece_status, x.to_status::piece_status,
            x.qty_before, x.qty_after, x.to_rack, x.from_rack, 'stock_count', $2, $3, x.note
       from unnest($4::uuid[], $5::text[], $6::text[], $7::numeric[], $8::numeric[],
                   $9::text[], $10::text[], $11::text[])
            as x(piece_id, from_status, to_status, qty_before, qty_after,
                 to_rack, from_rack, note)`,
    [
      ctx.tenantId, countId, ctx.userId,
      moves.map(x => x.r.piece_id), moves.map(x => x.r.live_status), moves.map(x => x.m.to),
      moves.map(x => Number(x.r.live_qty)), moves.map(x => x.m.qty),
      // from_rack is where it was, so cancelling the count can shelve it back.
      moves.map(x => x.m.rack), moves.map(x => x.r.live_rack),
      moves.map(x => `physical verification: ${x.r.outcome.replace(/_/g, ' ')}`)
    ]
  );

  // A shorter thaan is worth less and a longer one more. The adjustment lands
  // in other_cost so the original grey and jobwork figures stay readable, and
  // so cancelling the count is one subtraction.
  const valued = moves.filter(x => x.r.outcome === 'adjust_qty' && Number(x.r.value) !== 0);
  if (valued.length > 0) {
    await ctx.db.query(
      `update piece p set other_cost = p.other_cost + x.delta
         from unnest($1::uuid[], $2::numeric[]) as x(piece_id, delta)
        where p.id = x.piece_id`,
      [valued.map(x => x.r.piece_id), valued.map(x => round2(Number(x.r.value)))]
    );
  }

  return { moved: rows.length };
}
