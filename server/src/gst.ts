/**
 * GST computation for outward supplies of goods.
 *
 * Two rules do the work:
 *  - Place of supply for goods that move is where the movement terminates for
 *    delivery to the recipient, i.e. the ship-to state.
 *  - Supplier state equal to place of supply is intra-state (CGST + SGST at
 *    half the rate each); anything else is inter-state (IGST at the full rate).
 *
 * Everything is computed in paise as integers. Summing rounded rupee floats
 * drifts, and a tax total that is off by a paisa is a rejected return.
 */

export type SupplyType = 'intra_state' | 'inter_state' | 'export' | 'sez';

export interface TaxableLine {
  sno: number;
  pieceId?: string | null;
  qualityId: string;
  hsnCode: string;
  description: string;
  qty: number;
  uom: string;
  rate: number;
  discount?: number;
  gstRate: number;
}

export interface ComputedLine extends TaxableLine {
  taxableValue: number;
  cgstRate: number; cgstAmount: number;
  sgstRate: number; sgstAmount: number;
  igstRate: number; igstAmount: number;
  lineTotal: number;
}

export interface ComputedInvoice {
  supplyType: SupplyType;
  placeOfSupply: string;
  lines: ComputedLine[];
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  roundOff: number;
  invoiceTotal: number;
}

const toPaise = (rupees: number) => Math.round(rupees * 100);
const toRupees = (paise: number) => paise / 100;

/** Half-up on the absolute value, so -0.005 and 0.005 round symmetrically. */
function roundPaise(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

export function determineSupplyType(
  supplierStateCode: string,
  placeOfSupply: string,
  recipient: { gstRegType: string }
): SupplyType {
  if (recipient.gstRegType === 'overseas') return 'export';
  if (recipient.gstRegType === 'sez') return 'sez';
  return supplierStateCode === placeOfSupply ? 'intra_state' : 'inter_state';
}

export function computeInvoice(
  supplierStateCode: string,
  placeOfSupply: string,
  recipient: { gstRegType: string },
  lines: TaxableLine[],
  opts: { isRcm?: boolean } = {}
): ComputedInvoice {
  if (lines.length === 0) throw new Error('an invoice needs at least one line');

  const supplyType = determineSupplyType(supplierStateCode, placeOfSupply, recipient);
  const intra = supplyType === 'intra_state';
  // Exports and SEZ supplies are zero-rated; RCM shifts the charge to the buyer.
  const zeroRated = supplyType === 'export' || supplyType === 'sez' || !!opts.isRcm;

  let taxablePaise = 0;
  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;

  const computed: ComputedLine[] = lines.map(l => {
    if (l.qty < 0 || l.rate < 0) throw new Error(`line ${l.sno}: qty and rate cannot be negative`);

    const gross = toPaise(l.qty * l.rate);
    const disc = toPaise(l.discount ?? 0);
    const taxable = roundPaise(gross - disc);
    if (taxable < 0) throw new Error(`line ${l.sno}: discount exceeds line value`);

    const cgstRate = zeroRated ? 0 : intra ? l.gstRate / 2 : 0;
    const sgstRate = cgstRate;
    const igstRate = zeroRated ? 0 : intra ? 0 : l.gstRate;

    const cgst = roundPaise((taxable * cgstRate) / 100);
    const sgst = roundPaise((taxable * sgstRate) / 100);
    const igst = roundPaise((taxable * igstRate) / 100);

    taxablePaise += taxable;
    cgstPaise += cgst;
    sgstPaise += sgst;
    igstPaise += igst;

    return {
      ...l,
      taxableValue: toRupees(taxable),
      cgstRate, cgstAmount: toRupees(cgst),
      sgstRate, sgstAmount: toRupees(sgst),
      igstRate, igstAmount: toRupees(igst),
      lineTotal: toRupees(taxable + cgst + sgst + igst)
    };
  });

  const beforeRounding = taxablePaise + cgstPaise + sgstPaise + igstPaise;
  // Invoice totals are presented to the nearest rupee; the difference is booked.
  const rounded = Math.round(beforeRounding / 100) * 100;
  const roundOffPaise = rounded - beforeRounding;

  return {
    supplyType,
    placeOfSupply,
    lines: computed,
    taxableValue: toRupees(taxablePaise),
    cgstAmount: toRupees(cgstPaise),
    sgstAmount: toRupees(sgstPaise),
    igstAmount: toRupees(igstPaise),
    roundOff: toRupees(roundOffPaise),
    invoiceTotal: toRupees(rounded)
  };
}

/**
 * The double-entry for a tax invoice. Debit the customer the gross, credit
 * revenue the taxable value and each tax head its own amount.
 */
export function invoicePostingLines(
  inv: ComputedInvoice,
  ledgers: {
    party: string; sales: string; roundOff: string;
    cgstOutput: string; sgstOutput: string; igstOutput: string;
  }
) {
  const lines: { ledgerId: string; debit?: number; credit?: number }[] = [
    { ledgerId: ledgers.party, debit: inv.invoiceTotal },
    { ledgerId: ledgers.sales, credit: inv.taxableValue }
  ];
  if (inv.cgstAmount > 0) lines.push({ ledgerId: ledgers.cgstOutput, credit: inv.cgstAmount });
  if (inv.sgstAmount > 0) lines.push({ ledgerId: ledgers.sgstOutput, credit: inv.sgstAmount });
  if (inv.igstAmount > 0) lines.push({ ledgerId: ledgers.igstOutput, credit: inv.igstAmount });

  if (inv.roundOff > 0) lines.push({ ledgerId: ledgers.roundOff, credit: inv.roundOff });
  else if (inv.roundOff < 0) lines.push({ ledgerId: ledgers.roundOff, debit: -inv.roundOff });

  return lines;
}
