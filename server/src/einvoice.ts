/**
 * NIC e-invoice (INV-1, schema version 1.1) payload builder and validator.
 *
 * Field names, casing and mandatory flags follow the published Generate-IRN
 * schema; see docs/einvoice-schema.md for the sources these were taken from.
 * We validate locally first because the IRP rejects a whole payload for one
 * bad field, and a rejected invoice is a mill that cannot dispatch.
 */

export interface EinvoiceParty {
  gstin: string | null;
  legalName: string;
  tradeName?: string | null;
  address1: string;
  address2?: string | null;
  location: string;
  pincode: string | null;
  stateCode: string;
  phone?: string | null;
  email?: string | null;
}

export interface EinvoiceItem {
  slNo: number;
  description: string;
  isService: boolean;
  hsnCode: string;
  qty: number;
  unit: string;
  unitPrice: number;
  totalAmount: number;
  discount: number;
  assessableAmount: number;
  gstRate: number;
  igstAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  totalItemValue: number;
}

export interface EinvoiceInput {
  supplyType: 'intra_state' | 'inter_state' | 'export' | 'sez';
  isRcm: boolean;
  docNo: string;
  docDate: string;            // YYYY-MM-DD
  placeOfSupply: string;
  seller: EinvoiceParty;
  buyer: EinvoiceParty;
  items: EinvoiceItem[];
  totals: {
    assessableValue: number;
    cgst: number; sgst: number; igst: number;
    roundOff: number; invoiceTotal: number;
  };
  eway?: {
    transporterId?: string | null;
    transporterName?: string | null;
    mode?: '1' | '2' | '3' | '4';
    distanceKm: number;
    docNo?: string | null;
    docDate?: string | null;
    vehicleNo?: string | null;
    vehicleType?: 'O' | 'R';
  };
}

/** Unregistered buyers are B2C and are not eligible for an IRN at all. */
export function supTypFor(supplyType: EinvoiceInput['supplyType']): string {
  switch (supplyType) {
    case 'export': return 'EXPWP';
    case 'sez': return 'SEZWP';
    default: return 'B2B';
  }
}

const ddmmyyyy = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

const money = (n: number) => Math.round(n * 100) / 100;

export function buildEinvoicePayload(input: EinvoiceInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    Version: '1.1',
    TranDtls: {
      TaxSch: 'GST',
      SupTyp: supTypFor(input.supplyType),
      RegRev: input.isRcm ? 'Y' : 'N'
    },
    DocDtls: {
      Typ: 'INV',
      No: input.docNo,
      Dt: ddmmyyyy(input.docDate)
    },
    SellerDtls: partyBlock(input.seller, null),
    BuyerDtls: partyBlock(input.buyer, input.placeOfSupply),
    ItemList: input.items.map(i => ({
      SlNo: String(i.slNo),
      PrdDesc: i.description,
      IsServc: i.isService ? 'Y' : 'N',
      HsnCd: i.hsnCode,
      Qty: i.qty,
      Unit: i.unit,
      UnitPrice: money(i.unitPrice),
      TotAmt: money(i.totalAmount),
      Discount: money(i.discount),
      AssAmt: money(i.assessableAmount),
      GstRt: i.gstRate,
      IgstAmt: money(i.igstAmount),
      CgstAmt: money(i.cgstAmount),
      SgstAmt: money(i.sgstAmount),
      TotItemVal: money(i.totalItemValue)
    })),
    ValDtls: {
      AssVal: money(input.totals.assessableValue),
      CgstVal: money(input.totals.cgst),
      SgstVal: money(input.totals.sgst),
      IgstVal: money(input.totals.igst),
      RndOffAmt: money(input.totals.roundOff),
      TotInvVal: money(input.totals.invoiceTotal)
    }
  };

  if (input.eway) {
    payload.EwbDtls = {
      TransId: input.eway.transporterId ?? undefined,
      TransName: input.eway.transporterName ?? undefined,
      TransMode: input.eway.mode ?? undefined,
      Distance: input.eway.distanceKm,
      TransDocNo: input.eway.docNo ?? undefined,
      TransDocDt: input.eway.docDate ? ddmmyyyy(input.eway.docDate) : undefined,
      VehNo: input.eway.vehicleNo ?? undefined,
      VehType: input.eway.vehicleType ?? undefined
    };
  }

  return payload;
}

function partyBlock(p: EinvoiceParty, pos: string | null) {
  const block: Record<string, unknown> = {
    Gstin: p.gstin,
    LglNm: p.legalName,
    Addr1: p.address1,
    Loc: p.location,
    Pin: p.pincode ? Number(p.pincode) : undefined,
    Stcd: p.stateCode
  };
  if (p.tradeName) block.TrdNm = p.tradeName;
  if (p.address2) block.Addr2 = p.address2;
  if (p.phone) block.Ph = p.phone;
  if (p.email) block.Em = p.email;
  if (pos) block.Pos = pos;
  return block;
}

// ------------------------------------------------------------- validation --

export interface ValidationIssue { field: string; problem: string }

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/;
// The IRP restricts document numbers to alphanumerics plus slash and hyphen.
const DOC_NO = /^[A-Za-z0-9/-]{1,16}$/;

export function validateEinvoice(input: EinvoiceInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const bad = (field: string, problem: string) => issues.push({ field, problem });

  if (!DOC_NO.test(input.docNo)) {
    bad('DocDtls.No', `must be 1-16 chars of A-Z, 0-9, / or - (got "${input.docNo}")`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.docDate)) bad('DocDtls.Dt', 'must be YYYY-MM-DD');

  for (const [role, p] of [['SellerDtls', input.seller], ['BuyerDtls', input.buyer]] as const) {
    if (!p.gstin || !GSTIN.test(p.gstin)) bad(`${role}.Gstin`, `not a valid GSTIN (${p.gstin ?? 'null'})`);
    if (!p.legalName || p.legalName.length < 3) bad(`${role}.LglNm`, 'must be at least 3 characters');
    if (!p.address1) bad(`${role}.Addr1`, 'is mandatory');
    if (!p.location || p.location.length < 3) bad(`${role}.Loc`, 'must be at least 3 characters');
    if (!p.pincode || !/^\d{6}$/.test(p.pincode)) bad(`${role}.Pin`, 'must be a 6 digit pincode');
    if (!p.stateCode || !/^\d{1,2}$/.test(p.stateCode)) bad(`${role}.Stcd`, 'must be a 1-2 digit state code');
  }

  if (input.items.length === 0) bad('ItemList', 'at least one line is required');
  if (input.items.length > 1000) bad('ItemList', 'the IRP accepts at most 1000 lines per document');

  input.items.forEach(i => {
    const at = `ItemList[${i.slNo}]`;
    if (!i.hsnCode || i.hsnCode.length < 4) bad(`${at}.HsnCd`, 'HSN must be at least 4 digits');
    if (i.assessableAmount < 0) bad(`${at}.AssAmt`, 'cannot be negative');
    const expected = money(i.assessableAmount + i.cgstAmount + i.sgstAmount + i.igstAmount);
    if (Math.abs(expected - money(i.totalItemValue)) > 0.01) {
      bad(`${at}.TotItemVal`, `should be ${expected}, got ${money(i.totalItemValue)}`);
    }
  });

  // The IRP recomputes these and rejects on any mismatch beyond a rupee.
  const sumAss = money(input.items.reduce((n, i) => n + i.assessableAmount, 0));
  if (Math.abs(sumAss - money(input.totals.assessableValue)) > 0.01) {
    bad('ValDtls.AssVal', `does not match the sum of line AssAmt (${sumAss})`);
  }
  const computedTotal = money(
    input.totals.assessableValue + input.totals.cgst + input.totals.sgst +
    input.totals.igst + input.totals.roundOff
  );
  if (Math.abs(computedTotal - money(input.totals.invoiceTotal)) > 0.01) {
    bad('ValDtls.TotInvVal', `should be ${computedTotal}, got ${money(input.totals.invoiceTotal)}`);
  }

  if (input.supplyType === 'intra_state' && input.totals.igst > 0) {
    bad('ValDtls.IgstVal', 'an intra-state supply cannot carry IGST');
  }
  if (input.supplyType === 'inter_state' && (input.totals.cgst > 0 || input.totals.sgst > 0)) {
    bad('ValDtls.CgstVal', 'an inter-state supply cannot carry CGST or SGST');
  }
  if (input.eway && (input.eway.distanceKm < 1 || input.eway.distanceKm > 4000)) {
    bad('EwbDtls.Distance', 'must be between 1 and 4000 km');
  }

  return issues;
}
