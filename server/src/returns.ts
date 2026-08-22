import { one, many, nextDocNumber } from './db.ts';
import { type Ctx } from './domain.ts';
import { postVoucher } from './payments.ts';
import { roleLedgers } from './valuation.ts';
import { approvalFor, holdVoucher, recordEvent } from './approvals.ts';
import { round2, sumBy } from './money.ts';

export interface GreyReturnInput {
  weaverId: string;
  entryDate: string;
  challanNo: string;
  challanDate?: string;
  reason: string;
  lines: { barcode: string; qty: number }[];
}

export async function postGreyReturn(ctx: Ctx, input: GreyReturnInput) {
  if (input.lines.length === 0) throw new Error('Return needs at least one piece');

  const entryNo = await nextDocNumber(ctx.db, ctx.tenantId, 'grey_return', ctx.fy);

  const header = await one<{ id: string }>(
    ctx.db,
    `insert into grey_return (tenant_id, entry_no, entry_date, weaver_id, challan_no, challan_date, reason, status, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, 'approved', $8) returning id`,
    [ctx.tenantId, entryNo, input.entryDate, input.weaverId, input.challanNo, input.challanDate ?? null, input.reason, ctx.userId]
  );
  if (!header) throw new Error('Failed to create grey_return');

  const barcodes = input.lines.map(l => l.barcode);
  const pieces = await many<{
    id: string; barcode: string; current_qty: number; status: string;
    grey_cost: number; jobwork_cost: number; other_cost: number;
  }>(
    ctx.db,
    `select id, barcode, current_qty, status, grey_cost,
            coalesce(jobwork_cost, 0) as jobwork_cost, coalesce(other_cost, 0) as other_cost
       from piece where tenant_id = $1 and barcode = any($2::text[]) for update`,
    [ctx.tenantId, barcodes]
  );

  const pieceByBarcode = new Map(pieces.map(p => [p.barcode, p]));
  const pieceIds: string[] = [];
  const lineRates: number[] = [];
  let total = 0;

  for (const line of input.lines) {
    const p = pieceByBarcode.get(line.barcode);
    if (!p) throw new Error(`Piece not found: ${line.barcode}`);
    if (p.status !== 'grey_in_stock') throw new Error(`Piece ${line.barcode} is not in grey_in_stock`);
    if (Number(p.current_qty) !== line.qty) throw new Error(`Piece ${line.barcode} qty mismatch`);
    const value = round2(Number(p.grey_cost) + Number(p.jobwork_cost) + Number(p.other_cost));
    if (value <= 0) throw new Error(`Piece ${line.barcode} has no recorded inventory value`);
    pieceIds.push(p.id);
    lineRates.push(round2(value / Number(p.current_qty)));
    total += value;
  }
  total = round2(total);
  const needsApproval = await approvalFor(ctx.db, 'grey_return', total);
  const finalStatus = needsApproval ? 'pending_approval' : 'approved';
  await ctx.db.query('update grey_return set amount = $1, status = $2 where id = $3',
    [total, finalStatus, header.id]);

  await ctx.db.query(
    `insert into grey_return_line (tenant_id, return_id, piece_id, sno, return_qty, grey_rate)
     select $1, $2, x.piece_id, x.sno, x.return_qty, x.grey_rate
       from unnest($3::uuid[], $4::smallint[], $5::numeric[], $6::numeric[])
            as x(piece_id, sno, return_qty, grey_rate)`,
    [
      ctx.tenantId, header.id, pieceIds,
      input.lines.map((_, i) => i + 1),
      input.lines.map(l => l.qty),
      lineRates
    ]
  );

  const led = await roleLedgers(ctx.db);
  const postings = [
    { ledgerId: input.weaverId, debit: total },
    { ledgerId: led.need('inventory_grey'), credit: total }
  ];
  if (finalStatus === 'approved') {
    const voucherId = await postVoucher(ctx, 'debit_note', input.entryDate,
      `Grey Return ${entryNo}`, 'grey_return', header.id, postings);
    await ctx.db.query('update grey_return set voucher_id = $1 where id = $2', [voucherId, header.id]);
    await applyGreyReturn(ctx, header.id);
  } else {
    await holdVoucher(ctx, 'grey_return', header.id, 'debit_note', input.entryDate,
      `Grey Return ${entryNo}`, postings);
    await recordEvent(ctx, 'grey_return', header.id, 'submitted', total);
  }

  return { id: header.id, entryNo, status: finalStatus };
}

/** Runs only after the held voucher has been released.  Locking the current
 * pieces again makes a later movement fail the whole approval transaction,
 * instead of posting money ahead of the physical stock. */
export async function applyGreyReturn(ctx: Ctx, docId: string) {
  const header = await one<{ weaver_id: string }>(
    ctx.db, 'select weaver_id from grey_return where id = $1', [docId]
  );
  if (!header) throw new Error('Grey return not found');
  const lines = await many<{ piece_id: string; return_qty: number; status: string; current_qty: number }>(
    ctx.db,
    `select l.piece_id, l.return_qty, p.status::text, p.current_qty
       from grey_return_line l join piece p on p.id = l.piece_id
      where l.return_id = $1 for update of p`,
    [docId]
  );
  for (const line of lines) {
    if (line.status !== 'grey_in_stock' || Number(line.current_qty) !== Number(line.return_qty)) {
      throw new Error('Grey return stock has changed since it was submitted');
    }
  }
  await ctx.db.query(
    `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status, qty_before, qty_after, counterparty_id, doc_type, doc_id, created_by)
     select $1, x.piece_id, 'return_grey', 'grey_in_stock', 'returned_to_weaver', x.qty, 0, $2, 'grey_return', $3, $4
       from unnest($5::uuid[], $6::numeric[]) as x(piece_id, qty)`,
    [ctx.tenantId, header.weaver_id, docId, ctx.userId,
     lines.map(line => line.piece_id), lines.map(line => Number(line.return_qty))]
  );
}

export interface DyeingReturnInput {
  processHouseId: string;
  entryDate: string;
  challanNo: string;
  challanDate?: string;
  reason: string;
  lines: { barcode: string; qty: number }[];
}

export async function postDyeingReturn(ctx: Ctx, input: DyeingReturnInput) {
  if (input.lines.length === 0) throw new Error('Return needs at least one piece');

  const entryNo = await nextDocNumber(ctx.db, ctx.tenantId, 'dyeing_return', ctx.fy);

  const header = await one<{ id: string }>(
    ctx.db,
    `insert into dyeing_return (tenant_id, entry_no, entry_date, process_house_id, challan_no, challan_date, reason, status, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, 'approved', $8) returning id`,
    [ctx.tenantId, entryNo, input.entryDate, input.processHouseId, input.challanNo, input.challanDate ?? null, input.reason, ctx.userId]
  );
  if (!header) throw new Error('Failed to create dyeing_return');

  const barcodes = input.lines.map(l => l.barcode);
  const pieces = await many<{
    id: string; barcode: string; current_qty: number; status: string;
    grey_cost: number; jobwork_cost: number; other_cost: number;
  }>(
    ctx.db,
    `select id, barcode, current_qty, status, grey_cost,
            coalesce(jobwork_cost, 0) as jobwork_cost, coalesce(other_cost, 0) as other_cost
       from piece where tenant_id = $1 and barcode = any($2::text[]) for update`,
    [ctx.tenantId, barcodes]
  );

  const pieceByBarcode = new Map(pieces.map(p => [p.barcode, p]));
  const pieceIds: string[] = [];
  const jobworkRates: number[] = [];
  let total = 0;

  for (const line of input.lines) {
    const p = pieceByBarcode.get(line.barcode);
    if (!p) throw new Error(`Piece not found: ${line.barcode}`);
    if (p.status !== 'received_finish') throw new Error(`Piece ${line.barcode} is not received_finish`);
    if (Number(p.current_qty) !== line.qty) throw new Error(`Piece ${line.barcode} qty mismatch`);
    const value = round2(Number(p.grey_cost) + Number(p.jobwork_cost) + Number(p.other_cost));
    if (value <= 0) throw new Error(`Piece ${line.barcode} has no recorded inventory value`);
    pieceIds.push(p.id);
    jobworkRates.push(round2(Number(p.jobwork_cost) / Number(p.current_qty)));
    total += value;
  }
  total = round2(total);
  const needsApproval = await approvalFor(ctx.db, 'dyeing_return', total);
  const finalStatus = needsApproval ? 'pending_approval' : 'approved';
  await ctx.db.query('update dyeing_return set amount = $1, status = $2 where id = $3',
    [total, finalStatus, header.id]);

  await ctx.db.query(
    `insert into dyeing_return_line (tenant_id, return_id, piece_id, sno, return_qty, jobwork_rate)
     select $1, $2, x.piece_id, x.sno, x.return_qty, x.jobwork_rate
       from unnest($3::uuid[], $4::smallint[], $5::numeric[], $6::numeric[])
            as x(piece_id, sno, return_qty, jobwork_rate)`,
    [
      ctx.tenantId, header.id, pieceIds,
      input.lines.map((_, i) => i + 1),
      input.lines.map(l => l.qty),
      jobworkRates
    ]
  );

  const led = await roleLedgers(ctx.db);
  const postings = [
    { ledgerId: input.processHouseId, debit: total },
    { ledgerId: led.need('inventory_finish'), credit: total }
  ];
  if (finalStatus === 'approved') {
    const voucherId = await postVoucher(ctx, 'debit_note', input.entryDate,
      `Dyeing Return ${entryNo}`, 'dyeing_return', header.id, postings);
    await ctx.db.query('update dyeing_return set voucher_id = $1 where id = $2', [voucherId, header.id]);
    await applyDyeingReturn(ctx, header.id);
  } else {
    await holdVoucher(ctx, 'dyeing_return', header.id, 'debit_note', input.entryDate,
      `Dyeing Return ${entryNo}`, postings);
    await recordEvent(ctx, 'dyeing_return', header.id, 'submitted', total);
  }

  return { id: header.id, entryNo, status: finalStatus };
}

export async function applyDyeingReturn(ctx: Ctx, docId: string) {
  const header = await one<{ process_house_id: string }>(
    ctx.db, 'select process_house_id from dyeing_return where id = $1', [docId]
  );
  if (!header) throw new Error('Dyeing return not found');
  const lines = await many<{ piece_id: string; return_qty: number; status: string; current_qty: number }>(
    ctx.db,
    `select l.piece_id, l.return_qty, p.status::text, p.current_qty
       from dyeing_return_line l join piece p on p.id = l.piece_id
      where l.return_id = $1 for update of p`,
    [docId]
  );
  for (const line of lines) {
    if (line.status !== 'received_finish' || Number(line.current_qty) !== Number(line.return_qty)) {
      throw new Error('Dyeing return stock has changed since it was submitted');
    }
  }
  await ctx.db.query(
    `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status, qty_before, qty_after, counterparty_id, doc_type, doc_id, created_by)
     select $1, x.piece_id, 'return_finish', 'received_finish', 'returned_to_process_house', x.qty, 0, $2, 'dyeing_return', $3, $4
       from unnest($5::uuid[], $6::numeric[]) as x(piece_id, qty)`,
    [ctx.tenantId, header.process_house_id, docId, ctx.userId,
     lines.map(line => line.piece_id), lines.map(line => Number(line.return_qty))]
  );
}


// ------------------------------------------------------------- customer return --

export interface CustomerReturnInput {
  customerId: string;
  againstInvoiceId: string;
  entryDate: string;
  challanNo: string;
  challanDate?: string;
  reason: string;
  lines: { barcode: string; qty: number }[];
}

export async function postCustomerReturn(ctx: Ctx, input: CustomerReturnInput) {
  if (input.lines.length === 0) throw new Error('Return needs at least one piece');

  const inv = await one<{
    id: string; party_id: string; place_of_supply: string; supply_type: string; status: string;
  }>(
    ctx.db, 'select id, party_id, place_of_supply, supply_type, status::text from sales_invoice where id = $1',
    [input.againstInvoiceId]
  );
  if (!inv) throw new Error('Original invoice not found');
  if (inv.status !== 'approved') throw new Error('A customer return requires an approved original invoice');
  if (inv.party_id !== input.customerId) throw new Error('The selected invoice belongs to a different customer');

  const entryNo = await nextDocNumber(ctx.db, ctx.tenantId, 'customer_return', ctx.fy);

  const barcodes = input.lines.map(l => l.barcode);
  if (new Set(barcodes).size !== barcodes.length) throw new Error('a piece can appear only once on a customer return');
  const pieces = await many<{
    id: string; barcode: string; status: string; grey_cost: number; jobwork_cost: number; other_cost: number;
    invoice_qty: number; invoice_rate: number; taxable_value: number;
    cgst_amount: number; sgst_amount: number; igst_amount: number;
  }>(
    ctx.db,
    `select p.id, p.barcode, p.status::text, p.grey_cost,
            coalesce(p.jobwork_cost,0) as jobwork_cost, coalesce(p.other_cost,0) as other_cost,
            sil.qty as invoice_qty, sil.rate as invoice_rate, sil.taxable_value,
            sil.cgst_amount, sil.sgst_amount, sil.igst_amount
       from piece p
       join sales_invoice_line sil on sil.piece_id = p.id and sil.invoice_id = $2
      where p.tenant_id = $1 and p.barcode = any($3::text[])
      order by p.id for update`,
    [ctx.tenantId, input.againstInvoiceId, barcodes]
  );

  const pieceByBarcode = new Map(pieces.map(p => [p.barcode, p]));
  const pieceIds: string[] = [];
  const pieceQtys: number[] = [];
  const rates: number[] = [];
  let inventoryCost = 0;
  let taxableValue = 0;
  let cgstAmount = 0;
  let sgstAmount = 0;
  let igstAmount = 0;

  for (const line of input.lines) {
    const p = pieceByBarcode.get(line.barcode);
    if (!p) throw new Error(`Piece not found: ${line.barcode}`);
    if (p.status !== 'dispatched') throw new Error(`Piece ${line.barcode} is not dispatched`);
    if (round2(line.qty) !== round2(Number(p.invoice_qty))) {
      throw new Error(`Customer returns are piece-level: ${line.barcode} must return its invoiced quantity of ${p.invoice_qty}`);
    }
    pieceIds.push(p.id);
    pieceQtys.push(line.qty);
    rates.push(Number(p.invoice_rate));
    inventoryCost += Number(p.grey_cost) + Number(p.jobwork_cost) + Number(p.other_cost);
    taxableValue += Number(p.taxable_value);
    cgstAmount += Number(p.cgst_amount);
    sgstAmount += Number(p.sgst_amount);
    igstAmount += Number(p.igst_amount);
  }
  taxableValue = round2(taxableValue);
  cgstAmount = round2(cgstAmount);
  sgstAmount = round2(sgstAmount);
  igstAmount = round2(igstAmount);
  const noteTotal = round2(taxableValue + cgstAmount + sgstAmount + igstAmount);
  const needsApproval = await approvalFor(ctx.db, 'customer_return', noteTotal);
  const finalStatus = needsApproval ? 'pending_approval' : 'approved';

  const header = await one<{ id: string }>(
    ctx.db,
    `insert into customer_return (tenant_id, entry_no, entry_date, customer_id, against_invoice_id,
                                 challan_no, challan_date, reason, amount, status, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [ctx.tenantId, entryNo, input.entryDate, input.customerId, input.againstInvoiceId,
     input.challanNo, input.challanDate ?? null, input.reason, noteTotal, finalStatus, ctx.userId]
  );
  if (!header) throw new Error('customer return insert returned nothing');

  await ctx.db.query(
    `insert into customer_return_line (tenant_id, return_id, piece_id, sno, return_qty, rate)
     select $1, $2, x.piece_id, x.sno, x.return_qty, x.rate
       from unnest($3::uuid[], $4::smallint[], $5::numeric[], $6::numeric[])
            as x(piece_id, sno, return_qty, rate)`,
    [
      ctx.tenantId, header.id, pieceIds,
      input.lines.map((_, i) => i + 1),
      input.lines.map(l => l.qty),
      rates
    ]
  );

  const led = await roleLedgers(ctx.db);
  const postings = [
    { ledgerId: led.need('sales_finish'), debit: taxableValue },
    { ledgerId: input.customerId, credit: noteTotal },
    { ledgerId: led.need('inventory_finish'), debit: round2(inventoryCost) },
    { ledgerId: led.need('cogs'), credit: round2(inventoryCost) }
  ];
  if (cgstAmount > 0) postings.push({ ledgerId: led.need('cgst_output'), debit: cgstAmount });
  if (sgstAmount > 0) postings.push({ ledgerId: led.need('sgst_output'), debit: sgstAmount });
  if (igstAmount > 0) postings.push({ ledgerId: led.need('igst_output'), debit: igstAmount });

  if (finalStatus === 'approved') {
    const vId = await postVoucher(
      ctx, 'credit_note', input.entryDate,
      `Customer Return ${entryNo}`, 'customer_return', header.id, postings
    );
    await ctx.db.query('update customer_return set voucher_id = $1 where id = $2', [vId, header.id]);
    await applyCustomerReturn(ctx, header.id);
  } else {
    await holdVoucher(
      ctx, 'customer_return', header.id, 'credit_note', input.entryDate,
      `Customer Return ${entryNo}`, postings
    );
    await recordEvent(ctx, 'customer_return', header.id, 'submitted', noteTotal);
  }

  return { id: header.id, entryNo, status: finalStatus };
}

export async function applyCustomerReturn(ctx: Ctx, docId: string) {
  const cr = await one<{ entry_no: string; entry_date: string; customer_id: string; against_invoice_id: string; reason: string; voucher_id: string }>(
    ctx.db,
    'select entry_no, entry_date::text, customer_id, against_invoice_id, reason, voucher_id from customer_return where id = $1',
    [docId]
  );
  if (!cr) throw new Error('Customer return not found');

  const inv = await one<{ place_of_supply: string; supply_type: string; taxable_value: number; cgst_amount: number; sgst_amount: number; igst_amount: number }>(
    ctx.db, 'select place_of_supply, supply_type, taxable_value, cgst_amount, sgst_amount, igst_amount from sales_invoice where id = $1',
    [cr.against_invoice_id]
  );

  const lines = await many<{
    piece_id: string; return_qty: number; rate: number;
    taxable_value: number; cgst_amount: number; sgst_amount: number; igst_amount: number;
  }>(
    ctx.db,
    `select crl.piece_id, crl.return_qty, crl.rate,
            sil.taxable_value, sil.cgst_amount, sil.sgst_amount, sil.igst_amount
       from customer_return_line crl
       join sales_invoice_line sil on sil.piece_id = crl.piece_id and sil.invoice_id = $2
      where crl.return_id = $1`,
    [docId, cr.against_invoice_id]
  );

  const taxableValue = round2(lines.reduce((total, line) => total + Number(line.taxable_value), 0));
  const cgstAmount = round2(lines.reduce((total, line) => total + Number(line.cgst_amount), 0));
  const sgstAmount = round2(lines.reduce((total, line) => total + Number(line.sgst_amount), 0));
  const igstAmount = round2(lines.reduce((total, line) => total + Number(line.igst_amount), 0));
  const noteTotal = round2(taxableValue + cgstAmount + sgstAmount + igstAmount);

  const pieceIds = lines.map(l => l.piece_id);
  const pieceQtys = lines.map(l => l.return_qty);

  await ctx.db.query(
    `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status, qty_before, qty_after, counterparty_id, doc_type, doc_id, created_by)
     select $1, x.piece_id, 'customer_return', 'dispatched', 'received_finish', 0, x.qty, $2, 'customer_return', $3, $4
       from unnest($5::uuid[], $6::numeric[]) as x(piece_id, qty)`,
    [ctx.tenantId, cr.customer_id, docId, ctx.userId, pieceIds, pieceQtys]
  );

  if (cr.voucher_id) {
    const noteNo = await nextDocNumber(ctx.db, ctx.tenantId, 'credit_note', ctx.fy);
    await ctx.db.query(
      `insert into gst_note (tenant_id, note_no, note_kind, note_date, against_invoice_id, party_id,
                            reason, place_of_supply, supply_type, taxable_value, cgst_amount,
                            sgst_amount, igst_amount, note_total, voucher_id, source_doc, source_id, created_by)
       values ($1,$2,'credit',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'customer_return',$15,$16)`,
      [ctx.tenantId, noteNo, cr.entry_date, cr.against_invoice_id, cr.customer_id, cr.reason,
       inv!.place_of_supply, inv!.supply_type, taxableValue, cgstAmount, sgstAmount, igstAmount,
       noteTotal, cr.voucher_id, docId, ctx.userId]
    );
  }
}
