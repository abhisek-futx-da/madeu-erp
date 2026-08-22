/**
 * The three statutory documents a processing mill lives on and the system had
 * no representation of: the Rule 55 delivery challan that goes out with grey,
 * the Rule 138 e-way bill that must travel with it, and the ITC-04 return that
 * reports both. Plus the filing lock that stops a filed period from changing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEwayPayload, validateEway, validityDays, ewayRequired, SUB_SUPPLY, type EwayInput
} from '../src/eway.ts';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
let token = '';

async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

function sampleEway(over: Partial<EwayInput> = {}): EwayInput {
  return {
    supplyType: 'O',
    subSupplyType: SUB_SUPPLY.supply,
    docType: 'INV',
    docNo: 'NKT/26-27/74',
    docDate: '2026-09-10',
    from: {
      gstin: '27ANBPC3604Q1Z0', tradeName: 'Neelkamal Textiles',
      address1: 'Gala 143, Mankham Market', place: 'Bhiwandi',
      pincode: '421302', stateCode: '27'
    },
    to: {
      gstin: '33AAKCS9012P1ZT', tradeName: 'Supreme Textile And Garments',
      address1: 'Textile Market, South Gate', place: 'Madurai',
      pincode: '625001', stateCode: '33'
    },
    items: [{
      productName: 'Galaxy shirting', hsnCode: '551311',
      quantity: 190, qtyUnit: 'MTR', taxableAmount: 7600, igstRate: 5
    }],
    totalValue: 7600,
    igstValue: 380,
    distanceKm: 1180,
    vehicleNo: 'MH04FD8921',
    ...over
  };
}

// ------------------------------------------------------------ payload shape --

test('the payload matches the NIC EWB v1.03 request', () => {
  const p = buildEwayPayload(sampleEway()) as any;
  assert.equal(p.supplyType, 'O');
  assert.equal(p.subSupplyType, '1');
  assert.equal(p.docType, 'INV');
  // The portal wants DD/MM/YYYY here, not the ISO date we store.
  assert.equal(p.docDate, '10/09/2026');
  // Pincodes and state codes are numbers in this API, unlike the e-invoice one.
  assert.equal(p.fromPincode, 421302);
  assert.equal(typeof p.fromPincode, 'number');
  assert.equal(p.toStateCode, 33);
  assert.equal(p.transDistance, '1180');
  assert.equal(p.totInvValue, 7980);
  assert.equal(p.itemList[0].hsnCode, 551311);
  assert.equal(typeof p.itemList[0].hsnCode, 'number');
});

test('an unregistered job worker is URP, never a blank', () => {
  const p = buildEwayPayload(sampleEway({
    to: { ...sampleEway().to, gstin: null }
  })) as any;
  assert.equal(p.toGstin, 'URP');
});

test('job work carries sub-supply 4 on a delivery challan', () => {
  const p = buildEwayPayload(sampleEway({
    subSupplyType: SUB_SUPPLY.jobWork, docType: 'CHL', igstValue: 0
  })) as any;
  assert.equal(p.subSupplyType, '4');
  assert.equal(p.docType, 'CHL');
  assert.equal(p.igstValue, 0);
});

test('transporter details appear only when supplied', () => {
  const bare = buildEwayPayload(sampleEway({ vehicleNo: null })) as any;
  assert.equal(bare.vehicleNo, undefined);
  assert.equal(bare.transporterId, undefined);

  const full = buildEwayPayload(sampleEway({
    transporterGstin: '27AABFP5678N1Z9', transDocNo: 'LR-4471', transDocDate: '2026-09-10'
  })) as any;
  assert.equal(full.transporterId, '27AABFP5678N1Z9');
  assert.equal(full.transDocDate, '10/09/2026');
});

// -------------------------------------------------------------- validation --

test('a valid consignment raises no issues', () => {
  assert.deepEqual(validateEway(sampleEway()), []);
});

test('every field the portal rejects is caught locally first', () => {
  const cases: [Partial<EwayInput>, RegExp][] = [
    [{ docNo: 'THIS-NUMBER-IS-FAR-TOO-LONG-FOR-THE-PORTAL' }, /docNo/],
    [{ distanceKm: 0 }, /transDistance/],
    [{ distanceKm: 9999 }, /transDistance/],
    [{ vehicleNo: 'NOT A PLATE' }, /vehicleNo/],
    [{ vehicleNo: null, transporterGstin: null }, /vehicleNo/],
    [{ items: [] }, /itemList/],
    [{ totalValue: 9999 }, /totalValue/],
    [{ from: { ...sampleEway().from, gstin: null } }, /fromGstin/],
    [{ to: { ...sampleEway().to, pincode: '62500' } }, /toPincode/]
  ];
  for (const [over, expected] of cases) {
    const issues = validateEway(sampleEway(over));
    assert.ok(
      issues.some(i => expected.test(i.field) || expected.test(i.problem)),
      `expected ${expected} among ${JSON.stringify(issues)}`
    );
  }
});

test('an HSN shorter than four digits is refused', () => {
  const issues = validateEway(sampleEway({
    items: [{ ...sampleEway().items[0]!, hsnCode: '55' }]
  }));
  assert.ok(issues.some(i => /hsnCode/.test(i.field)));
});

// ------------------------------------------------------- rules 138(1)/(10) --

test('validity is one day per 200 km or part thereof', () => {
  assert.equal(validityDays(1), 1);
  assert.equal(validityDays(200), 1);
  assert.equal(validityDays(201), 2);
  assert.equal(validityDays(1180), 6);
  // Over-dimensional cargo gets a day per 20 km.
  assert.equal(validityDays(100, 'O'), 5);
});

test('the ₹50,000 threshold, and job work across a state line regardless', () => {
  assert.equal(ewayRequired(49_999, false, false), false);
  assert.equal(ewayRequired(50_001, false, false), true);
  assert.equal(ewayRequired(5_000, true, true), true);
  assert.equal(ewayRequired(5_000, false, true), false);
});

// ---------------------------------------------------------------- live API --

test('sign in', async () => {
  const r = await api('/api/auth/login', {
    method: 'POST', body: { email: 'owner@neelkamal.test', password: 'changeme' }
  });
  assert.equal(r.status, 200);
  token = r.body.token;
});

test('a delivery challan carries every field Rule 55 requires', async () => {
  const list = await api('/api/delivery-challans?limit=1');
  assert.equal(list.status, 200);
  assert.ok(list.body.total > 0, 'the seed should have issued grey to a dyeing house');

  const doc = await api(`/api/delivery-challans/${list.body.rows[0].issue_id}/print`);
  assert.equal(doc.status, 200);
  for (const field of [
    'challan_no', 'challan_date',
    'consignor_name', 'consignor_gstin', 'consignor_addr', 'consignor_pincode', 'consignor_state',
    'consignee_name', 'consignee_addr', 'consignee_pincode', 'consignee_state',
    'total_qty', 'taxable_value', 'amount_in_words'
  ]) {
    assert.ok(doc.body[field] !== null && doc.body[field] !== undefined, `missing ${field}`);
  }
  assert.ok(doc.body.lines.length > 0);
  // Rule 55(1)(d): HSN and quantity per description of goods.
  assert.ok(/^\d{4,8}$/.test(String(doc.body.lines[0].hsn_code)));
  assert.match(doc.body.amount_in_words, /^Rupees /);
});

/** A party with a registered address on file — an e-way bill cannot name a blank. */
async function invoiceWithAnAddressedBuyer() {
  const r = await api('/api/sales-invoices?q=Supreme&limit=100');
  const live = r.body.rows.filter((i: any) => i.status !== 'cancelled');
  assert.ok(live.length > 0, 'the seed should have billed Supreme Textile');
  return live[0];
}

test('an e-way bill is prepared from an invoice and stored with its payload', async () => {
  const invoice = await invoiceWithAnAddressedBuyer();

  const made = await api(`/api/eway-bills/invoice/${invoice.id}`, {
    method: 'POST', body: { distanceKm: 1180, vehicleNo: 'MH04FD8921' }
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.ok, true);
  assert.equal(made.body.ewayBill.validityDays, 6);

  const stored = await api(`/api/eway-bills/${made.body.ewayBill.id}/payload`);
  assert.equal(stored.status, 200);
  assert.equal((stored.body.payload as any).docNo, invoice.invoice_no);
});

test('only one live e-way bill exists per document', async () => {
  const invoice = await invoiceWithAnAddressedBuyer();
  const first = await api(`/api/eway-bills/invoice/${invoice.id}`,
    { method: 'POST', body: { distanceKm: 100, vehicleNo: 'MH04FD8921' } });
  const second = await api(`/api/eway-bills/invoice/${invoice.id}`,
    { method: 'POST', body: { distanceKm: 200, vehicleNo: 'MH04FD8921' } });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(second.status, 201, JSON.stringify(second.body));

  const list = await api('/api/eway-bills?limit=500');
  const live = list.body.rows.filter(
    (e: any) => e.source_doc === 'sales_invoice' && e.status !== 'cancelled'
      && e.doc_no === invoice.invoice_no
  );
  assert.equal(live.length, 1, 'a second bill was raised for the same invoice');
  // The repeat call updates the distance rather than duplicating the bill.
  assert.equal(Number(live[0].distance_km), 200);
});

test('ITC-04 reports what went out, what came back, and what is still there', async () => {
  const r = await api('/api/itc04/Q2-2026');
  assert.equal(r.status, 200);
  assert.ok(r.body.sent.length > 0, 'grey was issued in Q2');
  assert.ok(r.body.received.length > 0, 'finish came back in Q2');

  for (const row of r.body.sent.slice(0, 5)) {
    assert.match(row.job_worker_gstin, /^(\d{2}[A-Z0-9]{13}|URP)$/);
    assert.equal(row.uom, 'MTR');
    assert.ok(Number(row.qty) > 0);
    assert.equal(row.goods_type, '1');
  }
  // Table 5A ties each return to the challan the goods left on.
  for (const row of r.body.received.slice(0, 5)) {
    assert.ok(row.original_challan_no);
    assert.ok(Number(row.qty) <= Number(row.sent_qty), 'received more than was sent');
  }
});

test('a filed period cannot be changed behind the return', async () => {
  const period = '03-2027';
  const filed = await api('/api/filings', {
    method: 'POST', body: { returnType: 'GSTR1', returnPeriod: period, arn: 'AA2703270001X' }
  });
  assert.equal(filed.status, 201);

  try {
    const dispatches = await api('/api/dispatches?uninvoiced=true&limit=1');
    if (dispatches.body.rows.length > 0) {
      const blocked = await api('/api/sales-invoices', {
        method: 'POST',
        body: { dispatchId: dispatches.body.rows[0].id, invoiceDate: '2027-03-15' }
      });
      assert.equal(blocked.status, 400);
      assert.match(blocked.body.error, /already filed/i);
    }

    const listed = await api('/api/filings');
    assert.ok(listed.body.some((f: any) => f.return_period === period));
  } finally {
    // Leave the books open; the lock is the thing under test, not a fixture.
    await api(`/api/filings/GSTR1/${period}`, { method: 'DELETE' });
  }
});
