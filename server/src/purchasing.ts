import { one, nextDocNumber, type Db } from './db.ts';
import { computeInvoice, type TaxableLine } from './gst.ts';
import type { Ctx } from './domain.ts';
import { round2, sumBy } from './money.ts';
import { approvalFor, holdVoucher, recordEvent } from './approvals.ts';
import { settings, stringSetting } from './config.ts';

/**
 * Inward tax. Without this the mill can see what it owes but not what it can
 * claim, which is half a GST position and no use at filing time.
 */

async function inputRoles(ctx: Ctx) {
  const rows = await ctx.db.query(
    'select posting_role, id from ledger_account where posting_role is not null'
  );
  const map = new Map<string, string>(rows.rows.map((r: any) => [r.posting_role, r.id]));
  const need = (role: string) => {
    const id = map.get(role);
    if (!id) throw new Error(`no ledger is bound to the posting role "${role}"`);
    return id;
  };
  return {
    purchaseGrey: need('purchase_grey'),
    purchaseJobwork: need('purchase_jobwork'),
    cgstInput: need('cgst_input'),
    sgstInput: need('sgst_input'),
    igstInput: need('igst_input'),
    roundOff: need('round_off'),
    rcmLiability: need('rcm_liability')
  };
}

export interface PurchaseLineInput {
  hsnCode: string;
  description: string;
  qty: number;
  uom?: string;
  rate: number;
  gstRate: number;
}

export async function recordPurchaseInvoice(
  ctx: Ctx,
  header: {
    partyId: string;
    supplierInvoiceNo: string;
    invoiceDate: string;
    kind: 'grey' | 'jobwork';
    itcEligible?: boolean;
    sourceDoc?: string | null;
    sourceId?: string | null;
  },
  lines: PurchaseLineInput[]
) {
  if (lines.length === 0) throw new Error('a purchase invoice needs at least one line');

  const supplier = await one<{
    gstin: string | null; gst_reg_type: string; rcm_applicable: boolean; state_code: string | null;
  }>(
    ctx.db,
    `select la.gstin, la.gst_reg_type, la.rcm_applicable,
            coalesce(a.state_code, left(la.gstin, 2)) as state_code
       from ledger_account la
       left join lateral (
         select state_code from ledger_address where ledger_id = la.id
          order by is_primary desc limit 1
       ) a on true
      where la.id = $1`,
    [header.partyId]
  );
  if (!supplier) throw new Error('supplier not found');

  const tenant = await one<{ state_code: string }>(
    ctx.db, 'select state_code from tenant where id = $1', [ctx.tenantId]
  );
  if (!tenant) throw new Error('tenant not found');

  // On an inward supply the place of supply is the buyer: us.
  const placeOfSupply = tenant.state_code;
  const taxable: TaxableLine[] = lines.map((l, i) => ({
    sno: i + 1,
    qualityId: '',
    hsnCode: l.hsnCode,
    description: l.description,
    qty: l.qty,
    uom: l.uom ?? 'MTR',
    rate: l.rate,
    gstRate: l.gstRate
  }));

  const isRcm = supplier.rcm_applicable || supplier.gst_reg_type === 'unregistered';
  const companySettings = await settings(ctx.db);
  const rounding = stringSetting(
    companySettings, 'invoice.rounding', ['nearest_rupee', 'none'] as const, 'nearest_rupee'
  );
  const computed = computeInvoice(
    supplier.state_code ?? placeOfSupply, placeOfSupply,
    { gstRegType: supplier.gst_reg_type }, taxable, { isRcm, rounding }
  );

  // Under reverse charge the supplier bills without tax; we self-assess it.
  const selfAssessed = isRcm
    ? computeInvoice(supplier.state_code ?? placeOfSupply, placeOfSupply,
        { gstRegType: 'regular' }, taxable, { rounding })
    : null;

  const ourRef = await nextDocNumber(ctx.db, ctx.tenantId, 'purchase_invoice', ctx.fy);
  const itcEligible = header.itcEligible ?? true;

  const inv = await one<{ id: string }>(
    ctx.db,
    `insert into purchase_invoice (tenant_id, our_ref, supplier_invoice_no, invoice_date,
       party_id, source_doc, source_id, place_of_supply, supply_type, is_rcm,
       taxable_value, cgst_amount, sgst_amount, igst_amount, round_off, invoice_total,
       itc_eligible, status, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'approved',$18)
     returning id`,
    [ctx.tenantId, ourRef, header.supplierInvoiceNo, header.invoiceDate, header.partyId,
     header.sourceDoc ?? null, header.sourceId ?? null, placeOfSupply, computed.supplyType,
     isRcm, computed.taxableValue, computed.cgstAmount, computed.sgstAmount,
     computed.igstAmount, computed.roundOff, computed.invoiceTotal, itcEligible, ctx.userId]
  );
  if (!inv) throw new Error('purchase invoice insert returned nothing');

  await ctx.db.query(
    `insert into purchase_invoice_line (tenant_id, invoice_id, sno, hsn_code, description,
       qty, uom, rate, taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, line_total)
     select $1, $2, x.sno, x.hsn_code, x.description, x.qty, x.uom, x.rate,
            x.taxable_value, x.gst_rate, x.cgst_amount, x.sgst_amount, x.igst_amount, x.line_total
       from unnest($3::smallint[], $4::text[], $5::text[], $6::numeric[], $7::text[],
                   $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[],
                   $12::numeric[], $13::numeric[], $14::numeric[])
            as x(sno, hsn_code, description, qty, uom, rate, taxable_value, gst_rate,
                 cgst_amount, sgst_amount, igst_amount, line_total)`,
    [
      ctx.tenantId, inv.id,
      computed.lines.map(l => l.sno),
      computed.lines.map(l => l.hsnCode),
      computed.lines.map(l => l.description),
      computed.lines.map(l => l.qty),
      computed.lines.map(l => l.uom),
      computed.lines.map(l => l.rate),
      computed.lines.map(l => l.taxableValue),
      computed.lines.map(l => l.gstRate),
      computed.lines.map(l => l.cgstAmount),
      computed.lines.map(l => l.sgstAmount),
      computed.lines.map(l => l.igstAmount),
      computed.lines.map(l => l.lineTotal)
    ]
  );

  const led = await inputRoles(ctx);
  const expense = header.kind === 'jobwork' ? led.purchaseJobwork : led.purchaseGrey;

  const postings: { ledgerId: string; debit?: number; credit?: number }[] = [
    { ledgerId: expense, debit: computed.taxableValue }
  ];
  if (computed.cgstAmount > 0) postings.push({ ledgerId: led.cgstInput, debit: computed.cgstAmount });
  if (computed.sgstAmount > 0) postings.push({ ledgerId: led.sgstInput, debit: computed.sgstAmount });
  if (computed.igstAmount > 0) postings.push({ ledgerId: led.igstInput, debit: computed.igstAmount });
  // The party is credited the rounded total, so the rounding sits on the
  // opposite side to a sales invoice: rounded up is a cost, down is a gain.
  if (computed.roundOff > 0) postings.push({ ledgerId: led.roundOff, debit: computed.roundOff });
  else if (computed.roundOff < 0) postings.push({ ledgerId: led.roundOff, credit: -computed.roundOff });
  postings.push({ ledgerId: header.partyId, credit: computed.invoiceTotal });

  // Above the threshold the bill is booked but not posted until a second
  // person releases it.
  const approval = await approvalFor(ctx.db, 'purchase_invoice', computed.invoiceTotal);
  let voucherId: string | null = null;

  if (approval) {
    await holdVoucher(
      ctx, 'purchase_invoice', inv.id, 'purchase', header.invoiceDate,
      `Purchase ${ourRef} against ${header.supplierInvoiceNo}`, postings
    );
    await recordEvent(ctx, 'purchase_invoice', inv.id, 'submitted', computed.invoiceTotal);
    await ctx.db.query(
      `update purchase_invoice set status = 'pending_approval' where id = $1`, [inv.id]);
  } else {
    voucherId = await postVoucher(
      ctx, 'purchase', header.invoiceDate,
      `Purchase ${ourRef} against ${header.supplierInvoiceNo}`,
      'purchase_invoice', inv.id, postings
    );
  }

  // RCM: claim the credit and book the matching liability, netting to nothing.
  if (selfAssessed && itcEligible && !approval) {
    const rcmPostings: { ledgerId: string; debit?: number; credit?: number }[] = [];
    for (const [amount, ledger] of [
      [selfAssessed.cgstAmount, led.cgstInput],
      [selfAssessed.sgstAmount, led.sgstInput],
      [selfAssessed.igstAmount, led.igstInput]
    ] as const) {
      if (amount > 0) rcmPostings.push({ ledgerId: ledger, debit: amount });
    }
    const liability = selfAssessed.cgstAmount + selfAssessed.sgstAmount + selfAssessed.igstAmount;
    if (liability > 0) {
      rcmPostings.push({ ledgerId: led.rcmLiability, credit: Math.round(liability * 100) / 100 });
      await postVoucher(
        ctx, 'journal', header.invoiceDate,
        `RCM self-assessment on ${ourRef}`, 'purchase_invoice', inv.id, rcmPostings
      );
    }
  }

  if (voucherId) {
    await ctx.db.query('update purchase_invoice set voucher_id = $1 where id = $2',
      [voucherId, inv.id]);
  }

  return {
    id: inv.id, ourRef,
    status: approval ? 'pending_approval' : 'approved',
    awaitingApproval: approval ? { role: approval.role, threshold: approval.threshold } : null,
    supplyType: computed.supplyType,
    isRcm,
    taxableValue: computed.taxableValue,
    cgst: computed.cgstAmount,
    sgst: computed.sgstAmount,
    igst: computed.igstAmount,
    invoiceTotal: computed.invoiceTotal,
    itcClaimed: itcEligible
      ? (selfAssessed
          ? selfAssessed.cgstAmount + selfAssessed.sgstAmount + selfAssessed.igstAmount
          : computed.cgstAmount + computed.sgstAmount + computed.igstAmount)
      : 0
  };
}

// ------------------------------------------------------- credit / debit --

export async function raiseNote(
  ctx: Ctx,
  input: {
    kind: 'credit' | 'debit';
    againstInvoiceId: string;
    noteDate: string;
    reason: string;
    taxableValue: number;
  }
) {
  const inv = await one<{
    id: string; party_id: string; place_of_supply: string; supply_type: string;
    taxable_value: number; invoice_no: string;
  }>(
    ctx.db,
    `select id, party_id, place_of_supply, supply_type, taxable_value, invoice_no
       from sales_invoice where id = $1 and is_live(status)`,
    [input.againstInvoiceId]
  );
  if (!inv) throw new Error('invoice not found');
  if (input.taxableValue <= 0) throw new Error('a note must have a positive value');

  const already = await one<{ total: number }>(
    ctx.db,
    `select coalesce(sum(taxable_value), 0) as total from gst_note
      where against_invoice_id = $1 and note_kind = 'credit' and is_live(status)`,
    [input.againstInvoiceId]
  );
  if (input.kind === 'credit'
      && Number(already?.total ?? 0) + input.taxableValue > Number(inv.taxable_value) + 0.005) {
    throw new Error(
      `credit notes cannot exceed the invoice: ${inv.invoice_no} is ${inv.taxable_value}, ` +
      `already credited ${already?.total ?? 0}`
    );
  }

  // A note inherits the original supply type; the tax legs must match the invoice.
  const rate = await one<{ gst_rate: number }>(
    ctx.db,
    'select max(gst_rate) as gst_rate from sales_invoice_line where invoice_id = $1',
    [input.againstInvoiceId]
  );
  const gstRate = Number(rate?.gst_rate ?? 0);
  const intra = inv.supply_type === 'intra_state';

  const cgst = intra ? round2((input.taxableValue * gstRate) / 200) : 0;
  const sgst = cgst;
  const igst = intra ? 0 : round2((input.taxableValue * gstRate) / 100);
  const total = round2(input.taxableValue + cgst + sgst + igst);

  const seriesKey = input.kind === 'credit' ? 'credit_note' : 'debit_note';
  const noteNo = await nextDocNumber(ctx.db, ctx.tenantId, seriesKey, ctx.fy);

  const note = await one<{ id: string }>(
    ctx.db,
    `insert into gst_note (tenant_id, note_no, note_kind, note_date, against_invoice_id,
       party_id, reason, place_of_supply, supply_type, taxable_value,
       cgst_amount, sgst_amount, igst_amount, note_total, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
    [ctx.tenantId, noteNo, input.kind, input.noteDate, inv.id, inv.party_id, input.reason,
     inv.place_of_supply, inv.supply_type, input.taxableValue, cgst, sgst, igst, total, ctx.userId]
  );
  if (!note) throw new Error('note insert returned nothing');

  const roles = await ctx.db.query(
    'select posting_role, id from ledger_account where posting_role is not null'
  );
  const map = new Map<string, string>(roles.rows.map((r: any) => [r.posting_role, r.id]));
  const sales = map.get('sales_finish')!;
  const taxLedgers = intra
    ? [[cgst, map.get('cgst_output')!], [sgst, map.get('sgst_output')!]] as const
    : [[igst, map.get('igst_output')!]] as const;

  // A credit note reverses the sale; a debit note adds to it.
  const sign = input.kind === 'credit' ? -1 : 1;
  const postings: { ledgerId: string; debit?: number; credit?: number }[] = [];
  const put = (ledgerId: string, amount: number, side: 'debit' | 'credit') => {
    if (amount <= 0) return;
    postings.push(side === 'debit' ? { ledgerId, debit: amount } : { ledgerId, credit: amount });
  };

  if (sign < 0) {
    put(sales, input.taxableValue, 'debit');
    for (const [amt, led] of taxLedgers) put(led, amt, 'debit');
    put(inv.party_id, total, 'credit');
  } else {
    put(inv.party_id, total, 'debit');
    put(sales, input.taxableValue, 'credit');
    for (const [amt, led] of taxLedgers) put(led, amt, 'credit');
  }

  const voucherId = await postVoucher(
    ctx, input.kind === 'credit' ? 'credit_note' : 'debit_note', input.noteDate,
    `${input.kind === 'credit' ? 'Credit' : 'Debit'} note ${noteNo} against ${inv.invoice_no}: ${input.reason}`,
    'gst_note', note.id, postings
  );
  await ctx.db.query('update gst_note set voucher_id = $1 where id = $2', [voucherId, note.id]);

  return {
    id: note.id, noteNo, kind: input.kind,
    taxableValue: input.taxableValue, cgst, sgst, igst, noteTotal: total
  };
}

// ------------------------------------------------------------- shared --

async function postVoucher(
  ctx: Ctx, type: string, date: string, narration: string,
  sourceDoc: string, sourceId: string,
  postings: { ledgerId: string; debit?: number; credit?: number }[]
) {
  const drift = sumBy(postings, p => (p.debit ?? 0) - (p.credit ?? 0));
  if (Math.abs(drift) > 0.005) {
    throw new Error(`refusing to post an unbalanced ${type} voucher (drift ${drift.toFixed(2)})`);
  }

  const no = await nextDocNumber(ctx.db, ctx.tenantId, `voucher_${type}`, ctx.fy);
  const v = await one<{ id: string }>(
    ctx.db,
    `insert into voucher (tenant_id, voucher_no, voucher_type, voucher_date, narration,
                          source_doc, source_id, is_posted, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,true,$8) returning id`,
    [ctx.tenantId, no, type, date, narration, sourceDoc, sourceId, ctx.userId]
  );
  if (!v) throw new Error('voucher insert returned nothing');

  await ctx.db.query(
    `insert into voucher_line (tenant_id, voucher_id, ledger_id, debit, credit)
     select $1, $2, x.ledger_id, x.debit, x.credit
       from unnest($3::uuid[], $4::numeric[], $5::numeric[]) as x(ledger_id, debit, credit)`,
    [ctx.tenantId, v.id,
     postings.map(p => p.ledgerId),
     postings.map(p => p.debit ?? 0),
     postings.map(p => p.credit ?? 0)]
  );
  return v.id;
}
