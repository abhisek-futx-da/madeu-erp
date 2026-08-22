import { round2, sumBy } from './money.ts';
import type { ValidationIssue } from './einvoice.ts';

/**
 * Rule 138 e-way bill. Shape follows the NIC EWB API v1.03 GENEWAYBILL
 * request, so what is stored is what would be posted.
 *
 * The mill needs two of these. A finished-goods dispatch travels on an invoice
 * (`subSupplyType` 1, `docType` INV). Grey going to a dyeing house travels on
 * a delivery challan (`subSupplyType` 4 — Job Work, `docType` CHL) and is the
 * leg the system had no representation of at all.
 *
 * Nothing here talks to the portal. Generation against the live NIC gateway
 * needs a GSP subscription; this produces and validates the payload offline,
 * exactly as `einvoice.ts` does for the IRP.
 */

export const SUB_SUPPLY = {
  supply: '1',
  export: '3',
  jobWork: '4',
  saleOnApproval: '5',
  others: '8'
} as const;

export type SubSupplyType = (typeof SUB_SUPPLY)[keyof typeof SUB_SUPPLY];

export const TRANS_MODE = { road: '1', rail: '2', air: '3', ship: '4' } as const;

export interface EwayParty {
  gstin: string | null;
  tradeName: string;
  address1: string;
  address2?: string | null;
  place: string;
  pincode: string;
  stateCode: string;
}

export interface EwayItem {
  productName: string;
  hsnCode: string;
  quantity: number;
  qtyUnit: string;
  taxableAmount: number;
  cgstRate?: number;
  sgstRate?: number;
  igstRate?: number;
}

export interface EwayInput {
  supplyType: 'O' | 'I';
  subSupplyType: SubSupplyType;
  docType: 'INV' | 'CHL' | 'BIL' | 'BOE' | 'OTH';
  docNo: string;
  /** YYYY-MM-DD; the payload carries DD/MM/YYYY. */
  docDate: string;
  from: EwayParty;
  to: EwayParty;
  items: EwayItem[];
  totalValue: number;
  cgstValue?: number;
  sgstValue?: number;
  igstValue?: number;
  distanceKm: number;
  transMode?: string;
  transporterGstin?: string | null;
  transporterName?: string | null;
  transDocNo?: string | null;
  transDocDate?: string | null;
  vehicleNo?: string | null;
  vehicleType?: 'R' | 'O';
}

const ddmmyyyy = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

/**
 * Rule 138(10): one day for every 200 km or part thereof, counted from the
 * time the bill is generated. Over-dimensional cargo gets a day per 20 km.
 */
export function validityDays(distanceKm: number, vehicleType: 'R' | 'O' = 'R'): number {
  const per = vehicleType === 'O' ? 20 : 200;
  return Math.max(1, Math.ceil(distanceKm / per));
}

export function buildEwayPayload(input: EwayInput): Record<string, unknown> {
  // An unregistered job worker or buyer is URP, never a blank.
  const gstinOf = (p: EwayParty) => (p.gstin && p.gstin.length === 15 ? p.gstin : 'URP');

  const payload: Record<string, unknown> = {
    supplyType: input.supplyType,
    subSupplyType: input.subSupplyType,
    docType: input.docType,
    docNo: input.docNo,
    docDate: ddmmyyyy(input.docDate),

    fromGstin: gstinOf(input.from),
    fromTrdName: input.from.tradeName,
    fromAddr1: input.from.address1,
    fromAddr2: input.from.address2 ?? '',
    fromPlace: input.from.place,
    // The portal wants these numeric, not zero-padded strings.
    fromPincode: Number(input.from.pincode),
    fromStateCode: Number(input.from.stateCode),
    actFromStateCode: Number(input.from.stateCode),

    toGstin: gstinOf(input.to),
    toTrdName: input.to.tradeName,
    toAddr1: input.to.address1,
    toAddr2: input.to.address2 ?? '',
    toPlace: input.to.place,
    toPincode: Number(input.to.pincode),
    toStateCode: Number(input.to.stateCode),
    actToStateCode: Number(input.to.stateCode),

    totalValue: round2(input.totalValue),
    cgstValue: round2(input.cgstValue ?? 0),
    sgstValue: round2(input.sgstValue ?? 0),
    igstValue: round2(input.igstValue ?? 0),
    cessValue: 0,
    totInvValue: round2(
      input.totalValue + (input.cgstValue ?? 0) + (input.sgstValue ?? 0) + (input.igstValue ?? 0)
    ),

    transactionType: 1,
    transDistance: String(input.distanceKm),
    transMode: input.transMode ?? TRANS_MODE.road,

    itemList: input.items.map(i => ({
      productName: i.productName,
      hsnCode: Number(i.hsnCode),
      quantity: i.quantity,
      qtyUnit: i.qtyUnit,
      taxableAmount: round2(i.taxableAmount),
      cgstRate: i.cgstRate ?? 0,
      sgstRate: i.sgstRate ?? 0,
      igstRate: i.igstRate ?? 0,
      cessRate: 0
    }))
  };

  if (input.transporterGstin) payload.transporterId = input.transporterGstin;
  if (input.transporterName) payload.transporterName = input.transporterName;
  if (input.transDocNo) payload.transDocNo = input.transDocNo;
  if (input.transDocDate) payload.transDocDate = ddmmyyyy(input.transDocDate);
  if (input.vehicleNo) {
    payload.vehicleNo = input.vehicleNo;
    payload.vehicleType = input.vehicleType ?? 'R';
  }

  return payload;
}

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/;
// The portal's own format: two letters, two digits, up to two letters, four digits.
const VEHICLE = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/;
const DOC_NO = /^[A-Za-z0-9/-]{1,16}$/;

export function validateEway(input: EwayInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const bad = (field: string, problem: string) => issues.push({ field, problem });

  if (!DOC_NO.test(input.docNo)) {
    bad('docNo', `must be 1-16 chars of A-Z, 0-9, / or - (got "${input.docNo}")`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.docDate)) bad('docDate', 'must be YYYY-MM-DD');

  for (const [role, p] of [['from', input.from], ['to', input.to]] as const) {
    if (p.gstin && p.gstin !== 'URP' && !GSTIN.test(p.gstin)) {
      bad(`${role}Gstin`, `not a valid GSTIN (${p.gstin})`);
    }
    if (!p.tradeName || p.tradeName.length < 3) bad(`${role}TrdName`, 'must be at least 3 characters');
    if (!p.address1) bad(`${role}Addr1`, 'is mandatory');
    if (!p.pincode || !/^\d{6}$/.test(p.pincode)) bad(`${role}Pincode`, 'must be a 6 digit pincode');
    if (!p.stateCode || !/^\d{1,2}$/.test(p.stateCode)) {
      bad(`${role}StateCode`, 'must be a 1-2 digit state code');
    }
  }

  // The consignor must be registered — the mill is raising its own bill.
  if (!input.from.gstin || !GSTIN.test(input.from.gstin)) {
    bad('fromGstin', 'the consignor must be a registered person');
  }

  if (input.items.length === 0) bad('itemList', 'at least one line is required');
  input.items.forEach((i, idx) => {
    if (!/^\d{4,8}$/.test(i.hsnCode)) bad(`itemList[${idx}].hsnCode`, 'HSN must be 4 to 8 digits');
    if (i.quantity <= 0) bad(`itemList[${idx}].quantity`, 'must be positive');
  });

  const summed = sumBy(input.items, i => i.taxableAmount);
  if (Math.abs(summed - round2(input.totalValue)) > 0.01) {
    bad('totalValue', `does not match the sum of line taxableAmount (${summed})`);
  }

  if (!Number.isInteger(input.distanceKm) || input.distanceKm < 1 || input.distanceKm > 4000) {
    bad('transDistance', 'must be a whole number of kilometres between 1 and 4000');
  }

  // Part B may be filled later, but one of the two must be present to move.
  if (!input.vehicleNo && !input.transporterGstin) {
    bad('vehicleNo', 'either a vehicle number or a transporter is required to move goods');
  }
  if (input.vehicleNo && !VEHICLE.test(input.vehicleNo.replace(/[\s-]/g, '').toUpperCase())) {
    bad('vehicleNo', `not a valid registration (${input.vehicleNo})`);
  }
  if (input.transporterGstin && !GSTIN.test(input.transporterGstin)
      && !/^\d{2}[A-Z0-9]{13}$/.test(input.transporterGstin)) {
    bad('transporterId', 'must be a GSTIN or a 15-character TRANSIN');
  }

  return issues;
}

/**
 * Threshold check. Rule 138(1): an e-way bill is required for a consignment
 * over ₹50,000, including movement to a job worker — for which it is required
 * regardless of value on an inter-state leg.
 */
export function ewayRequired(consignmentValue: number, interState: boolean, jobWork: boolean) {
  if (jobWork && interState) return true;
  return consignmentValue > 50_000;
}
