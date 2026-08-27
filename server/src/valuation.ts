import { many, one, type Db } from './db.ts';
import { postVoucher } from './payments.ts';
import type { Ctx } from './domain.ts';
import { round2, sumBy } from './money.ts';

/**
 * Inventory valuation. Buying grey used to debit an expense, which meant the
 * P&L showed a loss the moment stock arrived and the balance sheet valued
 * every thaan at zero. Grey is an asset until it is sold; the cost follows the
 * piece and is released to cost of goods sold on dispatch.
 */


export async function roleLedgers(db: Db) {
  const rows = await many<{ posting_role: string; id: string }>(
    db, 'select posting_role, id from ledger_account where posting_role is not null'
  );
  const map = new Map(rows.map(r => [r.posting_role, r.id]));
  return {
    get: (role: string) => map.get(role),
    need: (role: string) => {
      const id = map.get(role);
      if (!id) throw new Error(`no ledger is bound to the posting role "${role}"`);
      return id;
    }
  };
}

/**
 * Grey arriving: capitalise it against the piece and the inventory account.
 *
 * The credit goes to the received-not-billed clearing account, not to the
 * weaver. Crediting him here and again when his bill arrives charged the mill
 * twice for one delivery; the bill now clears this accrual instead.
 * `partyId` is retained for the audit trail on the voucher, not for posting.
 */
export async function capitaliseGrey(
  ctx: Ctx,
  inwardId: string,
  pieces: { pieceId: string; cost: number }[],
  partyId: string,
  date: string,
  entryNo: string
) {
  await ctx.db.query(
    `update piece p set grey_cost = x.cost
       from unnest($1::uuid[], $2::numeric[]) as x(piece_id, cost)
      where p.id = x.piece_id`,
    [pieces.map(p => p.pieceId), pieces.map(p => round2(p.cost))]
  );

  const total = sumBy(pieces, p => p.cost);
  if (total <= 0) return null;

  const led = await roleLedgers(ctx.db);
  return postVoucher(
    ctx, 'purchase', date,
    `Grey inward ${entryNo}`, 'grey_inward', inwardId,
    [
      { ledgerId: led.need('inventory_grey'), debit: total },
      { ledgerId: led.need('grey_not_billed'), credit: total }
    ]
  );
}

/**
 * Jobwork adds to what the piece is worth and moves it to finish stock. The
 * processing charge accrues to received-not-billed for the same reason grey
 * does: the process house's own bill is what credits the process house.
 */
export async function capitaliseJobwork(
  ctx: Ctx,
  receiptId: string,
  pieces: { pieceId: string; cost: number }[],
  processHouseId: string,
  date: string,
  entryNo: string
) {
  await ctx.db.query(
    `update piece p set jobwork_cost = p.jobwork_cost + x.cost
       from unnest($1::uuid[], $2::numeric[]) as x(piece_id, cost)
      where p.id = x.piece_id`,
    [pieces.map(p => p.pieceId), pieces.map(p => round2(p.cost))]
  );

  const jobwork = sumBy(pieces, p => p.cost);
  if (jobwork <= 0) return null;

  // Grey leaves grey stock and lands in finish stock carrying its jobwork.
  const greyMoved = await one<{ total: number }>(
    ctx.db,
    `select coalesce(sum(grey_cost + other_cost), 0) as total
       from piece where id = any($1::uuid[])`,
    [pieces.map(p => p.pieceId)]
  );
  const grey = round2(Number(greyMoved?.total ?? 0));

  const led = await roleLedgers(ctx.db);
  return postVoucher(
    ctx, 'jobwork', date,
    `Dyeing receipt ${entryNo}`, 'dyeing_receipt', receiptId,
    [
      { ledgerId: led.need('inventory_finish'), debit: round2(grey + jobwork) },
      { ledgerId: led.need('inventory_grey'), credit: grey },
      { ledgerId: led.need('jobwork_not_billed'), credit: jobwork }
    ]
  );
}

/**
 * Selling: release the accumulated cost of the pieces that left to cost of
 * goods sold. Revenue is recognised on the invoice; this is the other half of
 * the same event, and without it gross margin is meaningless.
 */
export async function releaseCostOfSales(
  ctx: Ctx, dispatchId: string, date: string, challanNo: string
) {
  const rows = await many<{ piece_id: string; cost: number; status: string }>(
    ctx.db,
    `select p.id as piece_id, (p.grey_cost + p.jobwork_cost + p.other_cost) as cost,
            p.status::text
       from dispatch_line dl
       join piece p on p.id = dl.piece_id
      where dl.dispatch_id = $1 and not p.cost_posted`,
    [dispatchId]
  );
  if (rows.length === 0) return null;

  const total = sumBy(rows, r => Number(r.cost));
  if (total <= 0) return null;

  await ctx.db.query(
    'update piece set cost_posted = true where id = any($1::uuid[])',
    [rows.map(r => r.piece_id)]
  );

  const led = await roleLedgers(ctx.db);
  return postVoucher(
    ctx, 'journal', date,
    `Cost of goods sold on ${challanNo}`, 'dispatch', dispatchId,
    [
      { ledgerId: led.need('cogs'), debit: total },
      { ledgerId: led.need('inventory_finish'), credit: total }
    ]
  );
}

/** Gross margin per quality, now that cost is real rather than inferred. */
export async function grossMargin(db: Db) {
  return many(
    db,
    `select q.name as quality,
            sum(sl.qty)             as qty_sold,
            sum(sl.taxable_value)   as revenue,
            sum(p.grey_cost + p.jobwork_cost + p.other_cost) as cost,
            sum(sl.taxable_value) - sum(p.grey_cost + p.jobwork_cost + p.other_cost) as margin
       from sales_invoice_line sl
       join sales_invoice si on si.id = sl.invoice_id and si.status <> 'cancelled'
       join piece p on p.id = sl.piece_id
       join quality q on q.id = sl.quality_id
      group by q.name`
  );
}
