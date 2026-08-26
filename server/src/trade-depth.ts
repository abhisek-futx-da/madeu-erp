import { many, one, type Db } from './db.ts';
import type { Ctx } from './domain.ts';
import { openCount, addScans, submitCount } from './stockcount.ts';

/**
 * The trade details the incumbent has and we did not: what the customer calls
 * our cloth, which bale a thaan went into, which expected barcodes nobody
 * scanned, and a re-measure of one thaan without opening a count of the rack.
 *
 * The last one is the one to watch. A "quick adjust" is exactly how a
 * traceability spine acquires a back door, so it gets none — it opens a stock
 * count scoped to a single barcode and travels the same road as a count of the
 * whole godown: frozen snapshot, named difference, written reason, second
 * signature, movement and voucher posted together.
 */

// ------------------------------------------------------- the customer's words --

export interface AliasInput {
  partyId: string;
  qualityId: string;
  designId?: string | null;
  theirQuality?: string;
  theirDesign?: string;
  notes?: string;
}

export async function saveAlias(ctx: Ctx, input: AliasInput) {
  const theirQuality = (input.theirQuality ?? '').trim();
  const theirDesign = (input.theirDesign ?? '').trim();
  if (!theirQuality && !theirDesign) {
    throw new Error('give the customer\'s name for the quality, the design, or both');
  }

  // Upsert by scope rather than by id: the operator is answering "what does
  // this customer call this cloth", and asking twice must not make two answers.
  // Inferred rather than named: the uniqueness is a *partial* index, and
  // ON CONFLICT ON CONSTRAINT only accepts a real constraint.
  const scope = input.designId
    ? '(tenant_id, party_id, quality_id, design_id) where design_id is not null'
    : '(tenant_id, party_id, quality_id) where design_id is null';
  const row = await one<{ id: string }>(
    ctx.db,
    `insert into party_item_alias (tenant_id, party_id, quality_id, design_id,
                                   their_quality, their_design, notes, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict ${scope} do update
       set their_quality = excluded.their_quality,
           their_design  = excluded.their_design,
           notes         = excluded.notes
     returning id`,
    [ctx.tenantId, input.partyId, input.qualityId, input.designId ?? null,
     theirQuality, theirDesign, (input.notes ?? '').trim(), ctx.userId]
  );
  if (!row) throw new Error('could not save the alias');
  return { id: row.id, theirQuality, theirDesign };
}

export const listAliases = (db: Db, partyId?: string | null) => many(
  db,
  `select a.id, a.party_id, l.name as party, a.quality_id, q.name as quality,
          a.design_id, d.name as design, a.their_quality, a.their_design, a.notes
     from party_item_alias a
     join ledger_account l on l.id = a.party_id
     join quality q on q.id = a.quality_id
     left join design d on d.id = a.design_id
    where ($1::uuid is null or a.party_id = $1)
    order by l.name, q.name, d.name nulls first`,
  [partyId ?? null]
);

export const deleteAlias = async (db: Db, id: string) => {
  const gone = await db.query('delete from party_item_alias where id = $1', [id]);
  if (gone.rowCount === 0) throw new Error('no such alias');
  return { id, deleted: true };
};

// ---------------------------------------------------------------- bales --

/** The packing list as it is actually loaded onto the lorry: one part per bale. */
export const balesFor = (db: Db, dispatchId: string) => many(
  db,
  `select bale_no, pieces, qty, value, qualities, barcodes
     from v_dispatch_bale where dispatch_id = $1 order by bale_no`,
  [dispatchId]
);

// ------------------------------------------------------- missing barcodes --

/**
 * What a challan expected and nobody scanned.
 *
 * A dyeing receipt is checked against what went out on its issue; a dispatch
 * against the sales order it is picking. Both answer the only question a
 * storekeeper has at the loading bay: I counted thirty-eight, the paper says
 * forty, which two am I looking for.
 */
export async function missingFor(
  db: Db, kind: 'dyeing_issue' | 'sales_order', id: string, scanned: string[]
) {
  const sql = kind === 'dyeing_issue'
    ? `select p.barcode, q.name as quality, p.lot_no, il.issued_qty as qty
         from dyeing_issue_line il
         join piece p on p.id = il.piece_id
         join quality q on q.id = p.quality_id
        where il.issue_id = $1
          and not exists (select 1 from dyeing_receipt_line rl
                            join dyeing_receipt r on r.id = rl.receipt_id
                           where rl.issue_line_id = il.id and r.status <> 'cancelled')
        order by p.barcode`
    : `select p.barcode, q.name as quality, p.lot_no, p.current_qty as qty
         from piece p
         join quality q on q.id = p.quality_id
        where p.status in ('received_finish', 'cut_packed')
          and exists (select 1 from finish_sales_order_line sl
                       where sl.order_id = $1 and sl.quality_id = p.quality_id)
        order by p.barcode`;

  const expected = await many<{ barcode: string; quality: string; lot_no: string; qty: number }>(
    db, sql, [id]
  );
  const seen = new Set(scanned.map(b => b.trim()).filter(Boolean));
  const missing = expected.filter(e => !seen.has(e.barcode));
  const unexpected = [...seen].filter(b => !expected.some(e => e.barcode === b));

  return {
    expected: expected.length,
    scanned: seen.size,
    missing,
    unexpected,
    complete: missing.length === 0 && unexpected.length === 0
  };
}

// ---------------------------------------------------------- flow details --

/** One thaan's whole journey, for showing beside the document rather than in a report. */
export const flowFor = (db: Db, barcode: string) => many(
  db,
  `select event, from_status, to_status, qty_before, qty_after,
          from_rack, to_rack, counterparty, doc_type, occurred_at, note
     from v_barcode_history where barcode = $1 order by occurred_at, doc_type`,
  [barcode]
);

/** Every thaan on a document, with its journey — one statement, never one per line. */
export async function flowForDocument(db: Db, docType: string, docId: string) {
  const table: Record<string, string> = {
    grey_inward: 'select piece_id from grey_inward_line where inward_id = $1',
    dyeing_issue: 'select piece_id from dyeing_issue_line where issue_id = $1',
    dyeing_receipt: 'select piece_id from dyeing_receipt_line where receipt_id = $1',
    dispatch: 'select piece_id from dispatch_line where dispatch_id = $1'
  };
  const source = table[docType];
  if (!source) throw new Error(`no flow is kept for ${docType}`);

  return many(
    db,
    `select h.barcode, h.event, h.from_status, h.to_status, h.qty_before, h.qty_after,
            h.counterparty, h.doc_type, h.occurred_at
       from v_barcode_history h
      where h.barcode in (select p.barcode from piece p where p.id in (${source}))
      order by h.barcode, h.occurred_at`,
    [docId]
  );
}

// --------------------------------------------------- a re-measure of one --

/**
 * Re-measuring a single thaan on the floor.
 *
 * This looks like a shortcut and is deliberately not one. It opens a stock
 * count scoped to that barcode, records the measured length as its scan, and
 * submits it with the operator's reason — leaving a document that a second
 * person still has to approve before a metre or a rupee moves. The floor gets
 * its two-second interaction; the books get the same evidence they would have
 * had from counting the whole rack.
 */
export async function quickCheck(
  ctx: Ctx,
  input: { barcode: string; countedQty: number; reason: string; rackCode?: string | null }
) {
  const barcode = input.barcode.trim();
  if (!barcode) throw new Error('scan a barcode');
  if (!input.reason.trim()) throw new Error('a re-measure needs a reason');

  const piece = await one<{ current_qty: number; status: string }>(
    ctx.db,
    `select current_qty, status::text from piece
      where barcode = $1 and status in ('grey_in_stock','received_finish','cut_packed')`,
    [barcode]
  );
  if (!piece) throw new Error(`${barcode} is not a thaan in our own custody`);

  const count = await openCount(ctx, {
    countDate: new Date().toISOString().slice(0, 10),
    barcode,
    reason: `Floor re-measure: ${input.reason.trim()}`
  });

  await addScans(ctx, count.id, [{
    barcode, qty: input.countedQty, rackCode: input.rackCode ?? null,
    note: 'floor re-measure'
  }]);

  const same = Math.round(Number(piece.current_qty) * 100) === Math.round(input.countedQty * 100);
  const submitted = await submitCount(ctx, count.id, same ? [] : [{
    barcode,
    kind: input.countedQty < Number(piece.current_qty) ? 'short' : 'excess',
    outcome: 'adjust_qty',
    reason: input.reason.trim()
  }]);

  return {
    ...submitted,
    barcode,
    systemQty: Number(piece.current_qty),
    countedQty: input.countedQty,
    unchanged: same
  };
}
