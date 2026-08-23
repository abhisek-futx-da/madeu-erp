import { many, one } from './db.ts';
import { postVoucher } from './payments.ts';
import type { Ctx } from './domain.ts';
import { recordCancellation, type ApprovableDoc } from './approvals.ts';

/**
 * Cancelling a document. Nothing is deleted and nothing is edited in place:
 * the original stays visible, its vouchers are reversed, and any pieces it
 * moved are walked back with fresh movements. A mill voids documents daily and
 * the previous answer — that a mistyped invoice was permanent — was not one.
 */

type Kind =
  | 'sales_invoice' | 'purchase_invoice' | 'dispatch' | 'grey_inward'
  | 'dyeing_issue' | 'dyeing_receipt' | 'sales_order' | 'grey_purchase_order'
  | 'piece_regroup' | 'stock_count' | 'grey_return' | 'dyeing_return' | 'customer_return' | 'write_off'
  | 'dyeing_reprocess' | 'dyeing_reprocess_receipt'
  | 'gst_note';

const TABLE: Record<Kind, { table: string; label: string; movesPieces: boolean }> = {
  sales_invoice:       { table: 'sales_invoice',        label: 'invoice_no',  movesPieces: false },
  purchase_invoice:    { table: 'purchase_invoice',     label: 'our_ref',     movesPieces: false },
  dispatch:            { table: 'dispatch',             label: 'challan_no',  movesPieces: true },
  grey_inward:         { table: 'grey_inward',          label: 'entry_no',    movesPieces: true },
  dyeing_issue:        { table: 'dyeing_issue',         label: 'entry_no',    movesPieces: true },
  dyeing_receipt:      { table: 'dyeing_receipt',       label: 'entry_no',    movesPieces: true },
  sales_order:         { table: 'finish_sales_order',   label: 'order_no',    movesPieces: false },
  grey_purchase_order: { table: 'grey_purchase_order',  label: 'order_no',    movesPieces: false },
  piece_regroup:       { table: 'piece_regroup',        label: 'entry_no',    movesPieces: true },
  stock_count:         { table: 'stock_count',          label: 'count_no',    movesPieces: true },
  grey_return:         { table: 'grey_return',          label: 'entry_no',    movesPieces: true },
  dyeing_return:       { table: 'dyeing_return',        label: 'entry_no',    movesPieces: true },
  customer_return:     { table: 'customer_return',      label: 'entry_no',    movesPieces: true },
  write_off:           { table: 'write_off',            label: 'entry_no',    movesPieces: true },
  dyeing_reprocess:    { table: 'dyeing_reprocess',     label: 'issue_no',    movesPieces: true },
  dyeing_reprocess_receipt: {
    table: 'dyeing_reprocess_receipt', label: 'receipt_no', movesPieces: true
  },
  gst_note:            { table: 'gst_note',             label: 'note_no',     movesPieces: false }
};

type CancellableApprovableDoc = Exclude<ApprovableDoc, 'payment'>;

const APPROVABLE_DOCUMENTS: readonly CancellableApprovableDoc[] = [
  'sales_invoice', 'purchase_invoice', 'stock_count',
  'grey_return', 'dyeing_return', 'customer_return', 'write_off',
  'dyeing_reprocess_receipt'
];

function isApprovableDocument(kind: Kind): kind is CancellableApprovableDoc {
  return APPROVABLE_DOCUMENTS.includes(kind as CancellableApprovableDoc);
}

/** Where a piece goes back to when the document that moved it is cancelled. */
const REVERSE_TO: Record<string, string> = {
  inward: 'written_off',        // nothing precedes an inward, so retire the piece
  issue: 'grey_in_stock',
  receipt: 'issued_to_dyeing',
  pack: 'received_finish',
  dispatch: 'cut_packed',
  // Undoing a regroup retires the barcodes it created; the parents come back
  // through the other half of the same reversal.
  split: 'consumed',
  merge: 'consumed'
};

export async function cancelDocument(ctx: Ctx, kind: Kind, id: string, reason: string) {
  const spec = TABLE[kind];

  const doc = await one<{ label: string; status: string }>(
    ctx.db,
    `select ${spec.label} as label, status::text from ${spec.table} where id = $1`,
    [id]
  );
  if (!doc) throw new Error(`${kind.replace(/_/g, ' ')} not found`);
  if (doc.status === 'cancelled') throw new Error(`${doc.label} is already cancelled`);

  // Downstream first: an invoiced dispatch cannot be pulled out from under it.
  await assertNothingDependsOnIt(ctx, kind, id, doc.label);

  if (kind === 'sales_invoice') await reverseBrokerageForfeit(ctx, id, doc.label, reason);
  const reversedVouchers = await reverseVouchers(ctx, kind, id, doc.label, reason);
  // A maker-checker document has no posted voucher yet.  Cancelling it must
  // discard that held entry as well: otherwise an obsolete accounting entry
  // remains in the database and can be mistaken for work still awaiting a
  // decision.  This runs in the same transaction as the document cancellation.
  const droppedHeldVouchers = await discardHeldVouchers(ctx, kind, id);
  if (kind === 'customer_return') await cancelCustomerReturnNote(ctx, id);
  const revertedPieces = spec.movesPieces
    ? await revertPieceMovements(ctx, kind, id, reason)
    : 0;

  await ctx.db.query(
    `update ${spec.table} set status = 'cancelled' where id = $1`, [id]
  );
  if (kind === 'dyeing_reprocess_receipt') {
    await refreshReprocessStatus(ctx, id);
  }
  if (isApprovableDocument(kind)) {
    await recordCancellation(ctx, kind, id, reason);
  }

  return {
    document: doc.label, kind, cancelled: true,
    reversedVouchers, droppedHeldVouchers, revertedPieces, reason
  };
}

/** Reject and cancel both mean “this unposted accounting proposal is gone”. */
async function discardHeldVouchers(ctx: Ctx, kind: Kind, id: string): Promise<number> {
  const result = await ctx.db.query(
    `delete from deferred_voucher
      where tenant_id = $1 and doc_type = $2 and doc_id = $3 and posted_as is null`,
    [ctx.tenantId, kind, id]
  );
  return result.rowCount ?? 0;
}

async function assertNothingDependsOnIt(ctx: Ctx, kind: Kind, id: string, label: string) {
  const checks: Record<string, { sql: string; message: string }> = {
    dispatch: {
      sql: `select invoice_no from sales_invoice
             where dispatch_id = $1 and status <> 'cancelled' limit 1`,
      message: 'cancel the tax invoice first'
    },
    sales_invoice: {
      sql: `select ref from (
              select note_no as ref from gst_note
               where against_invoice_id=$1 and is_live(status)
              union all
              select p.voucher_no as ref from payment_allocation a
                join payment p on p.id=a.payment_id and p.status<>'cancelled'
               where a.sales_invoice_id=$1
            ) blockers limit 1`,
      message: 'cancel the linked credit/debit note or receipt first'
    },
    grey_purchase_order: {
      sql: `select gi.entry_no from grey_inward_line gil
              join grey_inward gi on gi.id = gil.inward_id
              join grey_purchase_order_line pol on pol.id = gil.po_line_id
             where pol.order_id = $1 and gi.status <> 'cancelled' limit 1`,
      message: 'cancel the linked grey inward first'
    },
    sales_order: {
      sql: `select d.challan_no from dispatch_line dl
              join dispatch d on d.id = dl.dispatch_id
              join finish_sales_order_line sol on sol.id = dl.so_line_id
             where sol.order_id = $1 and d.status <> 'cancelled' limit 1`,
      message: 'cancel the linked dispatch first'
    },
    grey_inward: {
      sql: `select di.entry_no from dyeing_issue_line dil
              join dyeing_issue di on di.id = dil.issue_id
              join grey_inward_line gil on gil.piece_id = dil.piece_id
             where gil.inward_id = $1 and di.status <> 'cancelled' limit 1`,
      message: 'the pieces have already gone out to dyeing'
    },
    dyeing_issue: {
      sql: `select dr.entry_no from dyeing_receipt_line drl
              join dyeing_receipt dr on dr.id = drl.receipt_id
              join dyeing_issue_line dil on dil.id = drl.issue_line_id
             where dil.issue_id = $1 and dr.status <> 'cancelled' limit 1`,
      message: 'the goods have already come back from dyeing'
    },
    dyeing_receipt: {
      sql: `select d.challan_no from dispatch_line dl
              join dispatch d on d.id = dl.dispatch_id
              join dyeing_receipt_line drl on drl.piece_id = dl.piece_id
             where drl.receipt_id = $1 and d.status <> 'cancelled' limit 1`,
      message: 'the pieces have already been dispatched'
    },
    dyeing_reprocess: {
      sql: `select receipt_no from dyeing_reprocess_receipt
             where reprocess_id = $1 and status not in ('rejected', 'cancelled') limit 1`,
      message: 'cancel or reject the reprocess receipt first'
    }
  };

  const check = checks[kind];
  if (!check) return;

  const blocker = await one<Record<string, string>>(ctx.db, check.sql, [id]);
  if (blocker) {
    const ref = Object.values(blocker)[0];
    throw new Error(`${label} cannot be cancelled: ${check.message} (${ref})`);
  }
}

async function reverseBrokerageForfeit(ctx: Ctx, invoiceId: string, label: string, reason: string) {
  const invoice = await one<{ brokerage_forfeit_voucher_id: string; voucher_date: string }>(ctx.db,
    `select i.brokerage_forfeit_voucher_id,v.voucher_date::text
       from sales_invoice i join voucher v on v.id=i.brokerage_forfeit_voucher_id
      where i.id=$1 and i.brokerage_state='forfeited' for update of i`, [invoiceId]);
  if (!invoice) return;
  const lines = await many<{ ledger_id: string; debit: number; credit: number }>(ctx.db,
    'select ledger_id,debit,credit from voucher_line where voucher_id=$1',
    [invoice.brokerage_forfeit_voucher_id]);
  await postVoucher(ctx, 'journal', invoice.voucher_date,
    `Reverse brokerage forfeiture before cancelling ${label}: ${reason}`,
    'brokerage_forfeit_reversal', invoiceId,
    lines.map(line => ({ ledgerId: line.ledger_id,
      debit: Number(line.credit) || undefined, credit: Number(line.debit) || undefined })));
  await ctx.db.query(
    `update sales_invoice set brokerage_state='accrued',brokerage_forfeit_voucher_id=null
      where id=$1`, [invoiceId]);
}

/** A return-generated credit note has the return's exact source id.  Mark it
 * cancelled in the same transaction as the reversal: never leave a GST report
 * reduced after the goods and ledger have been restored. */
async function cancelCustomerReturnNote(ctx: Ctx, customerReturnId: string) {
  await ctx.db.query(
    `update gst_note set status = 'cancelled'
      where tenant_id = $1 and source_doc = 'customer_return' and source_id = $2
        and status <> 'cancelled'`,
    [ctx.tenantId, customerReturnId]
  );
}

async function reverseVouchers(
  ctx: Ctx, kind: Kind, id: string, label: string, reason: string
): Promise<number> {
  const vouchers = await many<{ id: string; voucher_no: string; voucher_date: string }>(
    ctx.db,
    `select id, voucher_no, voucher_date::text from voucher
      where source_doc = $1 and source_id = $2 and is_posted`,
    [kind === 'sales_order' ? 'finish_sales_order' : kind, id]
  );

  for (const v of vouchers) {
    const lines = await many<{ ledger_id: string; debit: number; credit: number }>(
      ctx.db, 'select ledger_id, debit, credit from voucher_line where voucher_id = $1', [v.id]
    );
    if (lines.length === 0) continue;

    await postVoucher(
      ctx, 'journal', v.voucher_date,
      `Reversal of ${v.voucher_no} (${label} cancelled: ${reason})`,
      kind, id,
      lines.map(l => ({
        ledgerId: l.ledger_id,
        debit: Number(l.credit) || undefined,
        credit: Number(l.debit) || undefined
      }))
    );
  }
  return vouchers.length;
}

async function revertPieceMovements(
  ctx: Ctx, kind: Kind, id: string, reason: string
): Promise<number> {
  const moves = await many<{
    piece_id: string; event: string; from_status: string | null;
    to_status: string; qty_before: number; qty_after: number; current: string;
    from_rack: string | null; restore_counterparty: string | null;
  }>(
    ctx.db,
    `select m.piece_id, m.event::text, m.from_status::text, m.to_status::text,
            m.qty_before, m.qty_after, m.from_rack, p.status::text as current,
            (select prior.counterparty_id
               from piece_movement prior
              where prior.piece_id = m.piece_id and prior.id < m.id
                and prior.to_status = m.from_status
              order by prior.id desc limit 1) as restore_counterparty
       from piece_movement m
       join piece p on p.id = m.piece_id
      where m.doc_type = $1 and m.doc_id = $2
      order by m.id`,
    [kind, id]
  );
  if (moves.length === 0) return 0;

  // A document can move the same piece twice — a dispatch packs then ships —
  // so undo newest-first, and judge "has it moved on since?" on the newest.
  const byPiece = new Map<string, typeof moves>();
  for (const m of moves) {
    const bucket = byPiece.get(m.piece_id);
    if (bucket) bucket.push(m); else byPiece.set(m.piece_id, [m]);
  }

  const stuck = [...byPiece.values()].filter(ms => ms.at(-1)!.current !== ms.at(-1)!.to_status);
  if (stuck.length > 0) {
    throw new Error(
      `${stuck.length} piece(s) have moved on since; cancel the later document first`
    );
  }

  // One statement per hop depth keeps the order the guard requires.
  const depth = Math.max(...[...byPiece.values()].map(ms => ms.length));
  for (let step = 0; step < depth; step++) {
    const slice = [...byPiece.values()]
      .map(ms => [...ms].reverse()[step])
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map(m => ({
        pieceId: m.piece_id,
        from: m.to_status,
        to: m.from_status ?? REVERSE_TO[m.event] ?? 'written_off',
        qty: Number(m.qty_before),
        counterparty: ['issued_to_dyeing', 'reprocess_at_process_house'].includes(
          m.from_status ?? REVERSE_TO[m.event] ?? 'written_off'
        ) ? m.restore_counterparty : null,
        // Undoing a move that shelved a piece elsewhere puts it back.
        rack: m.from_rack
      }));
    if (slice.length === 0) continue;

    await ctx.db.query(
      `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                                   qty_before, qty_after, counterparty_id, to_rack,
                                   doc_type, doc_id, created_by, note)
       select $1, x.piece_id, 'adjust', x.from_status::piece_status, x.to_status::piece_status,
              x.qty, x.qty, x.counterparty, x.rack, $2, $3, $4, $5
         from unnest($6::uuid[], $7::text[], $8::text[], $9::numeric[], $10::uuid[], $11::text[])
              as x(piece_id, from_status, to_status, qty, counterparty, rack)`,
      [ctx.tenantId, `${kind}_cancel`, id, ctx.userId, `cancelled: ${reason}`,
       slice.map(b => b.pieceId), slice.map(b => b.from), slice.map(b => b.to),
       slice.map(b => b.qty), slice.map(b => b.counterparty), slice.map(b => b.rack)]
    );
  }

  // Cost released to COGS on a cancelled dispatch has to come back too.
  if (kind === 'dispatch') {
    await ctx.db.query(
      `update piece set cost_posted = false
        where id = any($1::uuid[])`,
      [[...byPiece.keys()]]
    );
    await ctx.db.query(
      `update finish_sales_order_line sol
          set dispatched_qty = greatest(0, sol.dispatched_qty - x.qty)
         from (select so_line_id, sum(qty) as qty from dispatch_line
                where dispatch_id = $1 and so_line_id is not null group by so_line_id) x
        where sol.id = x.so_line_id`, [id]
    );
    await ctx.db.query(
      `update finish_sales_order so
          set status = case
            when not exists (select 1 from finish_sales_order_line sl
                              where sl.order_id = so.id and sl.dispatched_qty > 0)
              then 'approved'::doc_status
            else 'partly_done'::doc_status
          end
        where so.id in (
          select distinct sol.order_id from dispatch_line dl
          join finish_sales_order_line sol on sol.id = dl.so_line_id
          where dl.dispatch_id = $1
        )`, [id]
    );
  }

  // Reversing a PO-linked receipt must reopen the order balance.  Otherwise
  // purchasing says the cloth is received after stock and accounts have both
  // been walked back.
  if (kind === 'grey_inward') {
    await ctx.db.query(
      `update grey_purchase_order_line pol
          set received_qty = greatest(0, pol.received_qty - x.qty)
         from (select po_line_id, sum(checked_qty) as qty from grey_inward_line
                where inward_id = $1 and po_line_id is not null group by po_line_id) x
        where pol.id = x.po_line_id`, [id]
    );
  }

  // A dyeing receipt moves grey cost to finish and capitalises the job charge.
  // Its voucher reversal is not enough: the piece cache must lose that exact
  // charge as well or stock valuation and the ledger disagree.
  if (kind === 'dyeing_receipt') {
    await ctx.db.query(
      `update piece p
          set jobwork_cost = p.jobwork_cost - x.cost,
              finish_qty = null
         from (select piece_id, sum(received_qty * job_rate) as cost
                 from dyeing_receipt_line where receipt_id = $1 group by piece_id) x
        where p.id = x.piece_id`, [id]
    );
    await ctx.db.query(
      'update dyeing_receipt_line set active = false where receipt_id = $1', [id]
    );
  }

  // A regroup posts no voucher — it moves cost between pieces rather than
  // between ledgers — so undoing it has to walk that cost back the same way.
  if (kind === 'piece_regroup') {
    for (const [side, sign] of [['parent_id', '+'], ['child_id', '-']] as const) {
      const isParent = side === 'parent_id';
      await ctx.db.query(
        `update piece p
            set grey_cost    = p.grey_cost    ${sign} (x.grey + ${isParent ? 'coalesce(r.loss_grey, 0)' : '0'}),
                jobwork_cost = p.jobwork_cost ${sign} (x.jobwork + ${isParent ? 'coalesce(r.loss_jobwork, 0)' : '0'}),
                other_cost   = p.other_cost   ${sign} (x.other + ${isParent ? 'coalesce(r.loss_other, 0)' : '0'})
           from (select ${side} as piece_id, sum(grey_cost) as grey,
                        sum(jobwork_cost) as jobwork, sum(other_cost) as other
                   from piece_lineage where regroup_id = $1 group by ${side}) x
           join piece_regroup r on r.id = $1
          where p.id = x.piece_id`,
        [id]
      );
    }
  }
  // A count writes its quantity correction into other_cost, so undoing it is
  // one subtraction — the grey and jobwork figures were never touched.
  if (kind === 'stock_count') {
    await ctx.db.query(
      `update piece p set other_cost = p.other_cost - x.delta
         from (select piece_id, sum(value) as delta from stock_count_variance
                where count_id = $1 and outcome = 'adjust_qty' and value <> 0
                group by piece_id) x
        where p.id = x.piece_id`,
      [id]
    );
  }
  // Reprocess adds only its incremental charge to finish inventory.  A
  // cancellation reverses the voucher above and must remove the same charge
  // from the piece-level valuation as well.
  if (kind === 'dyeing_reprocess_receipt') {
    await ctx.db.query(
      `update piece p set jobwork_cost = p.jobwork_cost - x.cost
         from (select piece_id, sum(additional_amount) as cost
                 from dyeing_reprocess_receipt_line
                where receipt_id = $1 group by piece_id) x
        where p.id = x.piece_id`, [id]
    );
  }
  return byPiece.size;
}

async function refreshReprocessStatus(ctx: Ctx, receiptId: string) {
  await ctx.db.query(
    `update dyeing_reprocess rp
        set status = case
          when not exists (
            select 1 from dyeing_reprocess_receipt_line rrl
            join dyeing_reprocess_receipt rr on rr.id = rrl.receipt_id
             where rr.reprocess_id = rp.id and rr.status = 'approved'
          ) then 'approved'::doc_status
          when exists (
            select 1 from dyeing_reprocess_line rl
             where rl.reprocess_id = rp.id and not exists (
               select 1 from dyeing_reprocess_receipt_line rrl
               join dyeing_reprocess_receipt rr on rr.id = rrl.receipt_id
                where rrl.reprocess_line_id = rl.id and rr.status = 'approved'
             )
          ) then 'partly_done'::doc_status
          else 'closed'::doc_status
        end
       from dyeing_reprocess_receipt target
      where target.id = $1 and rp.id = target.reprocess_id`, [receiptId]
  );
}
