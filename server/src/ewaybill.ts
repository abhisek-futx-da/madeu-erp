import { many, one, nextDocNumber } from './db.ts';
import type { Ctx } from './domain.ts';
import { round2, sumBy } from './money.ts';
import {
  buildEwayPayload, validateEway, validityDays, ewayRequired,
  SUB_SUPPLY, type EwayInput, type EwayParty
} from './eway.ts';

/**
 * Assembles a Rule 138 e-way bill from a document already in the books, so a
 * clerk never retypes an address or a consignment value that the system
 * already knows.
 */

interface TenantRow {
  legal_name: string; gstin: string; state_code: string;
  address1: string | null; city: string | null; pincode: string | null;
}

async function consignor(ctx: Ctx): Promise<EwayParty> {
  const t = await one<TenantRow>(
    ctx.db,
    `select legal_name, gstin, state_code, address1, city, pincode
       from tenant where id = $1`,
    [ctx.tenantId]
  );
  if (!t) throw new Error('the tenant record is missing');
  if (!t.address1 || !t.pincode) {
    throw new Error('this company has no registered address; set it before raising an e-way bill');
  }
  return {
    gstin: t.gstin, tradeName: t.legal_name, address1: t.address1,
    place: t.city ?? '', pincode: t.pincode, stateCode: t.state_code
  };
}

async function counterparty(ctx: Ctx, ledgerId: string): Promise<EwayParty> {
  const row = await one<{
    name: string; gstin: string | null; line1: string | null; city: string | null;
    pincode: string | null; state_code: string | null;
  }>(
    ctx.db,
    `select l.name, l.gstin, a.line1, a.city, a.pincode, a.state_code
       from ledger_account l
       left join lateral (
         select line1, city, pincode, state_code from ledger_address
          where ledger_id = l.id order by is_ship_to desc, is_primary desc limit 1
       ) a on true
      where l.id = $1`,
    [ledgerId]
  );
  if (!row) throw new Error('that party does not exist');
  if (!row.line1 || !row.pincode || !row.state_code) {
    throw new Error(`${row.name} has no address on file; an e-way bill cannot name a blank`);
  }
  return {
    gstin: row.gstin, tradeName: row.name, address1: row.line1,
    place: row.city ?? '', pincode: row.pincode, stateCode: row.state_code
  };
}

export interface EwayOptions {
  distanceKm: number;
  transMode?: string;
  transporterGstin?: string | null;
  transporterName?: string | null;
  transDocNo?: string | null;
  transDocDate?: string | null;
  vehicleNo?: string | null;
  vehicleType?: 'R' | 'O';
}

/** A finished-goods dispatch: the bill travels on the tax invoice. */
export async function ewayForInvoice(ctx: Ctx, invoiceId: string, opts: EwayOptions) {
  const head = await one<{
    invoice_no: string; invoice_date: string; party_id: string; dispatch_id: string | null;
    taxable_value: number; cgst_amount: number; sgst_amount: number; igst_amount: number;
    status: string; vehicle_no: string | null; lr_no: string | null;
    transporter_gstin: string | null; transporter_name: string | null;
  }>(
    ctx.db,
    `select i.invoice_no, i.invoice_date::text, i.party_id, i.dispatch_id,
            i.taxable_value, i.cgst_amount, i.sgst_amount, i.igst_amount, i.status,
            d.vehicle_no, d.lr_no, tr.gstin as transporter_gstin, tr.name as transporter_name
       from sales_invoice i
       left join dispatch d on d.id = i.dispatch_id
       left join ledger_account tr on tr.id = d.transport_id
      where i.id = $1`,
    [invoiceId]
  );
  if (!head) throw new Error('invoice not found');
  if (head.status === 'cancelled') throw new Error(`${head.invoice_no} is cancelled`);

  const lines = await many<{
    description: string; hsn_code: string; qty: number; uom: string;
    taxable_value: number; cgst_rate: number; sgst_rate: number; igst_rate: number;
  }>(
    ctx.db,
    `select description, hsn_code, qty, uom, taxable_value, cgst_rate, sgst_rate, igst_rate
       from sales_invoice_line where invoice_id = $1 order by sno`,
    [invoiceId]
  );

  const input: EwayInput = {
    supplyType: 'O',
    subSupplyType: SUB_SUPPLY.supply,
    docType: 'INV',
    docNo: head.invoice_no,
    docDate: head.invoice_date,
    from: await consignor(ctx),
    to: await counterparty(ctx, head.party_id),
    items: lines.map(l => ({
      productName: l.description, hsnCode: l.hsn_code,
      quantity: Number(l.qty), qtyUnit: l.uom,
      taxableAmount: Number(l.taxable_value),
      cgstRate: Number(l.cgst_rate), sgstRate: Number(l.sgst_rate), igstRate: Number(l.igst_rate)
    })),
    totalValue: Number(head.taxable_value),
    cgstValue: Number(head.cgst_amount),
    sgstValue: Number(head.sgst_amount),
    igstValue: Number(head.igst_amount),
    ...opts,
    vehicleNo: opts.vehicleNo ?? head.vehicle_no,
    transporterGstin: opts.transporterGstin ?? head.transporter_gstin,
    transporterName: opts.transporterName ?? head.transporter_name,
    transDocNo: opts.transDocNo ?? head.lr_no
  };

  return persist(ctx, 'sales_invoice', invoiceId, input, opts);
}

/**
 * Grey going out to a dyeing house. Not a supply, so no tax is charged, but
 * the goods still move and Rule 138 still applies — this is the leg a
 * processing mill runs every single day.
 */
export async function ewayForChallan(ctx: Ctx, issueId: string, opts: EwayOptions) {
  const head = await one<{
    challan_no: string; challan_date: string; process_house_id: string; status: string;
    vehicle_no: string | null; lr_no: string | null; taxable_value: number;
    transporter_gstin: string | null; transporter_name: string | null;
  }>(
    ctx.db,
    `select di.challan_no, di.challan_date::text, di.process_house_id, di.status,
            di.vehicle_no, di.lr_no, dc.taxable_value,
            tr.gstin as transporter_gstin, tr.name as transporter_name
       from dyeing_issue di
       join v_delivery_challan dc on dc.issue_id = di.id
       left join ledger_account tr on tr.id = di.transport_id
      where di.id = $1`,
    [issueId]
  );
  if (!head) throw new Error('delivery challan not found');
  if (head.status === 'cancelled') throw new Error(`${head.challan_no} is cancelled`);

  const lines = await many<{
    quality: string; hsn_code: string; qty: number; uom: string; taxable_value: number;
  }>(
    ctx.db,
    `select quality, hsn_code, qty, uom, taxable_value
       from v_delivery_challan_line where issue_id = $1 order by sno`,
    [issueId]
  );

  const input: EwayInput = {
    supplyType: 'O',
    subSupplyType: SUB_SUPPLY.jobWork,
    docType: 'CHL',
    docNo: head.challan_no,
    docDate: head.challan_date,
    from: await consignor(ctx),
    to: await counterparty(ctx, head.process_house_id),
    items: lines.map(l => ({
      productName: l.quality, hsnCode: l.hsn_code,
      quantity: Number(l.qty), qtyUnit: l.uom,
      taxableAmount: Number(l.taxable_value)
    })),
    // Job work is not a supply: the value declared is the value of the goods.
    totalValue: sumBy(lines, l => Number(l.taxable_value)),
    ...opts,
    vehicleNo: opts.vehicleNo ?? head.vehicle_no,
    transporterGstin: opts.transporterGstin ?? head.transporter_gstin,
    transporterName: opts.transporterName ?? head.transporter_name,
    transDocNo: opts.transDocNo ?? head.lr_no
  };

  return persist(ctx, 'dyeing_issue', issueId, input, opts);
}

async function persist(
  ctx: Ctx, sourceDoc: 'sales_invoice' | 'dyeing_issue', sourceId: string,
  input: EwayInput, opts: EwayOptions
) {
  const issues = validateEway(input);
  const interState = input.from.stateCode !== input.to.stateCode;
  const required = ewayRequired(
    round2(input.totalValue + (input.cgstValue ?? 0) + (input.sgstValue ?? 0) + (input.igstValue ?? 0)),
    interState,
    input.subSupplyType === SUB_SUPPLY.jobWork
  );

  if (issues.length > 0) {
    return { ok: false as const, required, interState, issues, payload: null, ewayBill: null };
  }

  const payload = buildEwayPayload(input);
  const ourRef = await nextDocNumber(ctx.db, ctx.tenantId, 'eway_bill', ctx.fy);
  const days = validityDays(input.distanceKm, input.vehicleType ?? 'R');

  const row = await one<{ id: string; our_ref: string; valid_until: string }>(
    ctx.db,
    `insert into eway_bill (tenant_id, source_doc, source_id, our_ref, supply_type,
       sub_supply_type, doc_type, doc_no, doc_date, from_gstin, from_pincode, from_state_code,
       to_gstin, to_pincode, to_state_code, distance_km, trans_mode, transporter_gstin,
       transporter_name, trans_doc_no, trans_doc_date, vehicle_no, vehicle_type,
       total_value, cgst_amount, sgst_amount, igst_amount, payload, valid_until,
       status, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
             $22,$23,$24,$25,$26,$27,$28, (current_date + ($29 || ' days')::interval)::date,
             'draft',$30)
     on conflict (tenant_id, source_doc, source_id) where status <> 'cancelled'
       do update set payload = excluded.payload, distance_km = excluded.distance_km,
                     vehicle_no = excluded.vehicle_no, trans_doc_no = excluded.trans_doc_no,
                     valid_until = excluded.valid_until
     returning id, our_ref, valid_until::text`,
    [ctx.tenantId, sourceDoc, sourceId, ourRef, input.supplyType,
     input.subSupplyType, input.docType, input.docNo, input.docDate,
     input.from.gstin, input.from.pincode, input.from.stateCode,
     input.to.gstin ?? 'URP', input.to.pincode, input.to.stateCode,
     input.distanceKm, input.transMode ?? '1', input.transporterGstin ?? null,
     input.transporterName ?? null, input.transDocNo ?? null, input.transDocDate ?? null,
     input.vehicleNo ?? null, input.vehicleType ?? 'R',
     round2(input.totalValue), round2(input.cgstValue ?? 0), round2(input.sgstValue ?? 0),
     round2(input.igstValue ?? 0), payload, days, ctx.userId]
  );
  if (!row) throw new Error('e-way bill insert returned nothing');

  return {
    ok: true as const,
    required, interState, issues: [],
    ewayBill: {
      id: row.id, ourRef: row.our_ref, validUntil: row.valid_until, validityDays: days,
      subSupplyType: input.subSupplyType, docType: input.docType,
      vehicleNo: opts.vehicleNo ?? input.vehicleNo ?? null
    },
    payload
  };
}
