import { one, many, nextDocNumber } from './db.ts';
import { type Ctx } from './domain.ts';
import { roleLedgers } from './valuation.ts';
import { round2 } from './money.ts';
import { holdVoucher, recordEvent, type Posting } from './approvals.ts';

export interface WriteOffInput {
  entryDate: string;
  reason: string;
  lines: { barcode: string }[];
}

export async function postWriteOff(ctx: Ctx, input: WriteOffInput) {
  if (input.lines.length === 0) throw new Error('Write-off needs at least one piece');
  const barcodes = input.lines.map(line => line.barcode.trim());
  if (barcodes.some(barcode => !barcode)) throw new Error('every write-off line needs a barcode');
  if (new Set(barcodes).size !== barcodes.length) throw new Error('a piece can be written off only once per document');

  const pieces = await many<{
    id: string; barcode: string; status: string;
    grey_cost: number; jobwork_cost: number; other_cost: number;
  }>(
    ctx.db,
    `select id, barcode, status::text, grey_cost, jobwork_cost, other_cost
       from piece
      where tenant_id = $1 and barcode = any($2::text[])
      order by id for update`,
    [ctx.tenantId, barcodes]
  );
  const byBarcode = new Map(pieces.map(piece => [piece.barcode, piece]));
  const missing = barcodes.filter(barcode => !byBarcode.has(barcode));
  if (missing.length > 0) throw new Error(`unknown barcode: ${missing.join(', ')}`);

  const booked = barcodes.map(barcode => byBarcode.get(barcode)!);
  const ineligible = booked.filter(piece =>
    piece.status !== 'grey_in_stock' && piece.status !== 'received_finish'
  );
  if (ineligible.length > 0) {
    throw new Error(`only stock in our custody can be written off: ${ineligible.map(piece => piece.barcode).join(', ')}`);
  }

  const values = booked.map(piece => round2(
    Number(piece.grey_cost) + Number(piece.jobwork_cost) + Number(piece.other_cost)
  ));
  const totalValue = round2(values.reduce((total, value) => total + value, 0));
  if (totalValue <= 0) throw new Error('a write-off needs a positive recorded inventory value');

  const entryNo = await nextDocNumber(ctx.db, ctx.tenantId, 'write_off', ctx.fy);
  const header = await one<{ id: string }>(
    ctx.db,
    `insert into write_off (tenant_id, entry_no, entry_date, reason, amount, status, created_by)
     values ($1, $2, $3, $4, $5, 'pending_approval', $6) returning id`,
    [ctx.tenantId, entryNo, input.entryDate, input.reason, totalValue, ctx.userId]
  );
  if (!header) throw new Error('write-off insert returned nothing');

  const writeOffId = header.id;
  await ctx.db.query(
    `insert into write_off_line (tenant_id, write_off_id, piece_id, value)
     select $1, $2, x.piece_id, x.value
       from unnest($3::uuid[], $4::numeric[]) as x(piece_id, value)`,
    [ctx.tenantId, writeOffId, booked.map(piece => piece.id), values]
  );

  const led = await roleLedgers(ctx.db);
  const greyValue = round2(booked
    .filter(piece => piece.status === 'grey_in_stock')
    .reduce((total, piece) => total + Number(piece.grey_cost) + Number(piece.jobwork_cost) + Number(piece.other_cost), 0));
  const finishValue = round2(totalValue - greyValue);
  const postings: Posting[] = [{ ledgerId: led.need('stock_loss'), debit: totalValue }];
  if (greyValue > 0) postings.push({ ledgerId: led.need('inventory_grey'), credit: greyValue });
  if (finishValue > 0) postings.push({ ledgerId: led.need('inventory_finish'), credit: finishValue });

  await holdVoucher(ctx, 'write_off', writeOffId, 'journal', input.entryDate, `Write-off ${entryNo}`, postings);
  await recordEvent(ctx, 'write_off', writeOffId, 'submitted', totalValue);

  return { writeOffId, entryNo, pieces: input.lines.length, value: round2(totalValue) };
}

export async function applyWriteOff(ctx: Ctx, writeOffId: string) {
  const lines = await many<{ piece_id: string; current_qty: number; status: string }>(
    ctx.db,
    `select wl.piece_id, p.current_qty, p.status::text
       from write_off_line wl
       join piece p on p.id = wl.piece_id
      where wl.write_off_id = $1 and wl.tenant_id = $2
        for update of p`,
    [writeOffId, ctx.tenantId]
  );

  for (const l of lines) {
    await ctx.db.query(
      `insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                                   qty_before, qty_after, doc_type, doc_id, created_by, note)
       values ($1, $2, 'write_off', $3::piece_status, 'written_off', $4, 0, 'write_off', $5, $6, 'Written off')`,
      [ctx.tenantId, l.piece_id, l.status, l.current_qty, writeOffId, ctx.userId]
    );
  }
}
