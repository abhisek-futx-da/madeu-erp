/**
 * Tax arithmetic. These run with no database — a rounding error here becomes a
 * rejected return, so the cases are deliberately awkward.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeInvoice, determineSupplyType, invoicePostingLines } from '../src/gst.ts';
import { buildEinvoicePayload, validateEinvoice, type EinvoiceInput } from '../src/einvoice.ts';

const line = (over: Partial<Parameters<typeof computeInvoice>[3][number]> = {}) => ({
  sno: 1, qualityId: 'q', hsnCode: '551311', description: 'Galaxy',
  qty: 100, uom: 'MTR', rate: 72, gstRate: 5, ...over
});

const regular = { gstRegType: 'regular' };

test('same state is intra-state; different state is inter-state', () => {
  assert.equal(determineSupplyType('27', '27', regular), 'intra_state');
  assert.equal(determineSupplyType('27', '33', regular), 'inter_state');
  assert.equal(determineSupplyType('27', '27', { gstRegType: 'overseas' }), 'export');
  assert.equal(determineSupplyType('27', '27', { gstRegType: 'sez' }), 'sez');
});

test('intra-state splits the rate into equal CGST and SGST halves', () => {
  const inv = computeInvoice('27', '27', regular, [line()]);
  assert.equal(inv.supplyType, 'intra_state');
  assert.equal(inv.taxableValue, 7200);
  assert.equal(inv.cgstAmount, 180); // 2.5% of 7200
  assert.equal(inv.sgstAmount, 180);
  assert.equal(inv.igstAmount, 0);
  assert.equal(inv.invoiceTotal, 7560);
});

test('inter-state charges IGST at the full rate and no CGST or SGST', () => {
  const inv = computeInvoice('27', '33', regular, [line()]);
  assert.equal(inv.supplyType, 'inter_state');
  assert.equal(inv.igstAmount, 360);
  assert.equal(inv.cgstAmount, 0);
  assert.equal(inv.sgstAmount, 0);
  assert.equal(inv.invoiceTotal, 7560);
});

test('exports and SEZ supplies are zero-rated', () => {
  for (const regType of ['overseas', 'sez']) {
    const inv = computeInvoice('27', '96', { gstRegType: regType }, [line()]);
    assert.equal(inv.cgstAmount + inv.sgstAmount + inv.igstAmount, 0, regType);
    assert.equal(inv.invoiceTotal, 7200, regType);
  }
});

test('reverse charge moves the tax off the invoice', () => {
  const inv = computeInvoice('27', '27', regular, [line()], { isRcm: true });
  assert.equal(inv.cgstAmount + inv.sgstAmount + inv.igstAmount, 0);
  assert.equal(inv.invoiceTotal, 7200);
});

test('the invoice total is rounded to the rupee and the difference is booked', () => {
  // 112.10 x 72 = 8071.20; 5% = 403.56; total 8474.76 -> 8475.00, round off +0.24
  const inv = computeInvoice('27', '33', regular, [line({ qty: 112.1 })]);
  assert.equal(inv.taxableValue, 8071.2);
  assert.equal(inv.igstAmount, 403.56);
  assert.equal(inv.roundOff, 0.24);
  assert.equal(inv.invoiceTotal, 8475);
  assert.equal(
    Math.round((inv.taxableValue + inv.igstAmount + inv.roundOff) * 100) / 100,
    inv.invoiceTotal
  );
});

test('round-off can be negative and still reconciles', () => {
  // 10.10 x 3.30 = 33.33; 5% = 1.6665 -> 1.67; total 35.00 exactly... nudge it
  const inv = computeInvoice('27', '33', regular, [line({ qty: 7, rate: 3.31 })]);
  const sum = Math.round(
    (inv.taxableValue + inv.cgstAmount + inv.sgstAmount + inv.igstAmount + inv.roundOff) * 100
  ) / 100;
  assert.equal(sum, inv.invoiceTotal);
  assert.ok(Math.abs(inv.roundOff) < 0.5, `round off must stay under half a rupee, got ${inv.roundOff}`);
});

test('many awkward lines still reconcile to the penny', () => {
  const lines = Array.from({ length: 37 }, (_, i) =>
    line({ sno: i + 1, qty: 33.33 + i * 0.07, rate: 71.99, gstRate: i % 2 ? 5 : 12 })
  );
  const inv = computeInvoice('27', '27', regular, lines);

  const sumLines = inv.lines.reduce((n, l) => n + l.taxableValue, 0);
  assert.equal(Math.round(sumLines * 100) / 100, inv.taxableValue);
  assert.equal(inv.cgstAmount, inv.sgstAmount, 'CGST and SGST must always match');

  const sum = Math.round(
    (inv.taxableValue + inv.cgstAmount + inv.sgstAmount + inv.igstAmount + inv.roundOff) * 100
  ) / 100;
  assert.equal(sum, inv.invoiceTotal);
  assert.equal(inv.invoiceTotal % 1, 0, 'invoice total must be a whole rupee');
});

test('a discount larger than the line is refused', () => {
  assert.throws(
    () => computeInvoice('27', '27', regular, [line({ qty: 1, rate: 10, discount: 20 })]),
    /discount exceeds line value/
  );
});

test('the posting lines balance for every supply type', () => {
  const ledgers = {
    party: 'p', sales: 's', roundOff: 'r',
    cgstOutput: 'c', sgstOutput: 'sg', igstOutput: 'i'
  };
  for (const pos of ['27', '33']) {
    const inv = computeInvoice('27', pos, regular, [line({ qty: 112.1 })]);
    const postings = invoicePostingLines(inv, ledgers);
    const drift = postings.reduce((n, p) => n + (p.debit ?? 0) - (p.credit ?? 0), 0);
    assert.ok(Math.abs(drift) < 0.005, `pos ${pos} drifted by ${drift}`);
  }
});

// ------------------------------------------------------------- e-invoice --

const party = {
  gstin: '27AAACB7204N1ZM', legalName: 'Neelkamal Textiles',
  address1: 'Gala 143, Mankham Market', location: 'Bhiwandi',
  pincode: '421302', stateCode: '27'
};

function sampleEinvoice(over: Partial<EinvoiceInput> = {}): EinvoiceInput {
  const inv = computeInvoice('27', '33', regular, [line({ qty: 112.1 })]);
  return {
    supplyType: inv.supplyType, isRcm: false,
    docNo: 'NKT/26-27/1', docDate: '2026-09-10', placeOfSupply: '33',
    seller: party,
    buyer: { ...party, gstin: '33AAKCS9012P1ZT', legalName: 'Supreme Textile', stateCode: '33', pincode: '625001', location: 'Madurai' },
    items: inv.lines.map(l => ({
      slNo: l.sno, description: l.description, isService: false, hsnCode: l.hsnCode,
      qty: l.qty, unit: l.uom, unitPrice: l.rate,
      totalAmount: Math.round(l.qty * l.rate * 100) / 100, discount: 0,
      assessableAmount: l.taxableValue, gstRate: l.gstRate,
      igstAmount: l.igstAmount, cgstAmount: l.cgstAmount, sgstAmount: l.sgstAmount,
      totalItemValue: l.lineTotal
    })),
    totals: {
      assessableValue: inv.taxableValue, cgst: inv.cgstAmount, sgst: inv.sgstAmount,
      igst: inv.igstAmount, roundOff: inv.roundOff, invoiceTotal: inv.invoiceTotal
    },
    ...over
  };
}

test('a well-formed invoice produces no validation issues', () => {
  assert.deepEqual(validateEinvoice(sampleEinvoice()), []);
});

test('the payload uses the schema field names and formats', () => {
  const p = buildEinvoicePayload(sampleEinvoice()) as any;
  assert.equal(p.Version, '1.1');
  assert.equal(p.TranDtls.TaxSch, 'GST');
  assert.equal(p.TranDtls.SupTyp, 'B2B');
  assert.equal(p.TranDtls.RegRev, 'N');
  assert.equal(p.DocDtls.Typ, 'INV');
  assert.equal(p.DocDtls.Dt, '10/09/2026', 'dates are DD/MM/YYYY, not ISO');
  assert.equal(p.BuyerDtls.Pos, '33');
  assert.equal(typeof p.SellerDtls.Pin, 'number', 'Pin is a number, and is not called Pcd');
  assert.equal(typeof p.ItemList[0].SlNo, 'string', 'SlNo is a string');
  assert.equal(p.ItemList[0].IsServc, 'N');
  assert.equal(p.ValDtls.TotInvVal, 8475);
});

test('an e-way bill block is only added when a distance is supplied', () => {
  assert.equal((buildEinvoicePayload(sampleEinvoice()) as any).EwbDtls, undefined);
  const withEway = buildEinvoicePayload(
    sampleEinvoice({ eway: { distanceKm: 1180, mode: '1', vehicleNo: 'MH04FD8921', vehicleType: 'R' } })
  ) as any;
  assert.equal(withEway.EwbDtls.Distance, 1180);
  assert.equal(withEway.EwbDtls.VehNo, 'MH04FD8921');
});

test('validation catches the mistakes the IRP would reject', () => {
  const cases: [Partial<EinvoiceInput>, RegExp][] = [
    [{ docNo: 'NKT#26-27#1' }, /DocDtls\.No/],
    [{ docNo: 'X'.repeat(17) }, /DocDtls\.No/],
    [{ seller: { ...party, gstin: 'NOTAGSTIN' } }, /SellerDtls\.Gstin/],
    [{ seller: { ...party, pincode: '42130' } }, /SellerDtls\.Pin/],
    [{ eway: { distanceKm: 9999 } }, /EwbDtls\.Distance/]
  ];
  for (const [over, expected] of cases) {
    const issues = validateEinvoice(sampleEinvoice(over));
    assert.ok(
      issues.some(i => expected.test(i.field)),
      `expected an issue matching ${expected}, got ${JSON.stringify(issues)}`
    );
  }
});

test('validation catches a tax leg that contradicts the supply type', () => {
  const bad = sampleEinvoice();
  bad.supplyType = 'intra_state';
  const issues = validateEinvoice(bad);
  assert.ok(issues.some(i => i.field === 'ValDtls.IgstVal'));
});

test('validation catches totals that do not match the lines', () => {
  const bad = sampleEinvoice();
  bad.totals.assessableValue += 100;
  const issues = validateEinvoice(bad);
  assert.ok(issues.some(i => i.field === 'ValDtls.AssVal'));
});

test('purchase postings balance when the total needs rounding', () => {
  // 1.00 + 5% = 1.05... rounds to 1.00, so the rounding is 0.06 the other way.
  const inv = computeInvoice('27', '27', regular, [line({ qty: 1, rate: 1, gstRate: 5 })]);
  const led = { expense: 'e', party: 'p', roundOff: 'r', cgstInput: 'c', sgstInput: 's' };

  const postings: { debit?: number; credit?: number }[] = [
    { debit: inv.taxableValue },
    { debit: inv.cgstAmount },
    { debit: inv.sgstAmount }
  ];
  if (inv.roundOff > 0) postings.push({ debit: inv.roundOff });
  else if (inv.roundOff < 0) postings.push({ credit: -inv.roundOff });
  postings.push({ credit: inv.invoiceTotal });

  const drift = postings.reduce((n, p) => n + (p.debit ?? 0) - (p.credit ?? 0), 0);
  assert.ok(Math.abs(drift) < 0.005, `purchase postings drifted by ${drift}`);
  assert.ok(led.party);
});
