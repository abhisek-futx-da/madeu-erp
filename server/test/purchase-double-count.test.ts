/**
 * Does booking the supplier's bill for goods already taken into stock charge
 * the mill twice?
 *
 * It used to. Grey inward capitalised the goods (Dr inventory / Cr the weaver)
 * and his bill posted them again (Dr purchase expense / Cr the weaver), so one
 * delivery credited him twice and the cost sat in an asset and an expense at
 * once. The trial balance still balanced, because both sides had doubled —
 * which is exactly why nothing caught it.
 *
 * The delivery now accrues to a clearing liability and the bill clears it.
 * These tests hold that line, in both directions: a bill against a receipt
 * settles it, and a bill standing on its own is still a purchase.
 *
 * This test asserts the books are right. If it fails, it is not the test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const WEAVER = '33333333-0000-0000-0000-000000000105';
const OTHER_SUPPLIER = '33333333-0000-0000-0000-000000000104';
const QUALITY_GALAXY = '44444444-0000-0000-0000-000000000001';
const GREY_STOCK = '33333333-0000-0000-0000-000000000960';

const stamp = Date.now();
let token = '';
let GREY_NOT_BILLED = '';
let INWARD_ID = '';

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

const paise = (n: unknown) => Math.round(Number(n ?? 0) * 100);

async function balance(ledgerId: string) {
  const r = await api('/api/reports/party-balance?limit=1000');
  const row = (r.body as any[]).find(x => x.ledger_id === ledgerId);
  return row ? paise(row.balance) : 0;
}

/** The clearing ledgers are created by migration, so they have no fixed id. */
async function ledgerIdByCode(code: string) {
  const r = await api('/api/ledgers?limit=500');
  const rows = Array.isArray(r.body) ? r.body : r.body.rows;
  const row = rows.find((l: any) => l.code === code);
  assert.ok(row, `no ledger with code ${code}`);
  return row.id as string;
}

test('sign in', async () => {
  const r = await api('/api/auth/login', {
    method: 'POST', body: { email: 'owner@neelkamal.test', password: 'changeme' }
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  token = r.body.token;
});

test('taking grey into stock values it and accrues it, without billing the weaver', async () => {
  GREY_NOT_BILLED = await ledgerIdByCode('991');
  const before = await balance(WEAVER);
  const stockBefore = await balance(GREY_STOCK);
  const accruedBefore = await balance(GREY_NOT_BILLED);

  const barcode = `DC${stamp}`;
  const r = await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: WEAVER, entryDate: '2026-09-01',
      challanNo: `DC-${stamp}`, challanDate: '2026-09-01', lotNo: `DC-${stamp}`,
      lines: [{ qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode, lotNo: `DC-${stamp}`,
                receivedQty: 1000, checkedQty: 1000, rate: 30.5 }]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  INWARD_ID = r.body.id;

  // 1000 x 30.50 = 30,500.00 into stock, accrued as not-yet-billed.
  assert.equal(await balance(GREY_STOCK) - stockBefore, 3050000);
  assert.equal(await balance(GREY_NOT_BILLED) - accruedBefore, -3050000);
  // The weaver is credited by his bill, not by the delivery. Crediting him
  // here as well is what charged the mill twice for one lot of goods.
  assert.equal(await balance(WEAVER) - before, 0,
    'the delivery moved the weaver\'s balance before he had billed anything');
});

/**
 * Fixed 2026-08-27 by migration 068: the inward accrues to Grey Received —
 * Not Yet Billed, and this bill clears that accrual rather than booking the
 * goods a second time. Before the fix the weaver showed 62,525.00 for one
 * delivery worth 32,025.00 inclusive of GST, and the trial balance still
 * balanced because both sides had doubled.
 */
test('the supplier bill for those same goods must not charge the mill twice', async () => {
  const weaverBefore = await balance(WEAVER);
  const stockBefore = await balance(GREY_STOCK);
  const accruedBefore = await balance(GREY_NOT_BILLED);

  const r = await api('/api/purchase-invoices', {
    method: 'POST',
    body: {
      partyId: WEAVER, supplierInvoiceNo: `DCSUP-${stamp}`, invoiceDate: '2026-09-01',
      kind: 'grey',
      sourceDoc: 'grey_inward', sourceId: INWARD_ID,
      lines: [{ hsnCode: '551311', description: 'Galaxy grey', qty: 1000, rate: 30.5, gstRate: 5 }]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  const weaverMoved = weaverBefore - await balance(WEAVER);
  const stockMoved = await balance(GREY_STOCK) - stockBefore;
  const accrualMoved = await balance(GREY_NOT_BILLED) - accruedBefore;

  // The weaver is credited the whole bill, 30,500 + 5% GST, exactly once.
  assert.equal(weaverMoved, 3202500,
    `the weaver was credited ${weaverMoved / 100} against a bill of 32,025.00`);
  // The accrual raised at inward is cleared by the bill, back to nothing.
  assert.equal(accrualMoved, 3050000,
    'the bill did not clear what the delivery accrued');
  assert.equal(stockMoved, 0,
    'the bill moved the stock value again after the inward already capitalised it');
});

test('a bill that stands behind no delivery is still an ordinary purchase', async () => {
  const before = await balance(WEAVER);
  const accruedBefore = await balance(GREY_NOT_BILLED);

  // No sourceDoc: nothing was received against this, so nothing is cleared.
  const r = await api('/api/purchase-invoices', {
    method: 'POST',
    body: {
      partyId: WEAVER, supplierInvoiceNo: `DCLOOSE-${stamp}`, invoiceDate: '2026-09-01',
      kind: 'grey',
      lines: [{ hsnCode: '551311', description: 'Galaxy grey', qty: 100, rate: 30.5, gstRate: 5 }]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  // Taken from the invoice itself: the mill rounds to the nearest rupee, and
  // restating that here would only test the test's own arithmetic.
  assert.equal(before - await balance(WEAVER), paise(r.body.invoiceTotal),
    'the weaver was not credited his bill');
  assert.equal(await balance(GREY_NOT_BILLED) - accruedBefore, 0,
    'a bill with no delivery behind it cleared an accrual that was never raised');
});

test('a bill cannot be pinned to another supplier\'s delivery', async () => {
  const inward = await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: WEAVER, entryDate: '2026-09-01',
      challanNo: `DCX-${stamp}`, challanDate: '2026-09-01', lotNo: `DCX-${stamp}`,
      lines: [{ qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode: `DCX${stamp}`,
                lotNo: `DCX-${stamp}`, receivedQty: 10, checkedQty: 10, rate: 30.5 }]
    }
  });
  assert.equal(inward.status, 201, JSON.stringify(inward.body));

  const wrongParty = await api('/api/purchase-invoices', {
    method: 'POST',
    body: {
      partyId: OTHER_SUPPLIER, supplierInvoiceNo: `DCWRONG-${stamp}`,
      invoiceDate: '2026-09-01', kind: 'grey',
      sourceDoc: 'grey_inward', sourceId: inward.body.id,
      lines: [{ hsnCode: '551311', description: 'Galaxy grey', qty: 10, rate: 30.5, gstRate: 5 }]
    }
  });
  assert.equal(wrongParty.status, 400, JSON.stringify(wrongParty.body));
  assert.match(wrongParty.body.error, /not received from this supplier/);

  const noSuchDoc = await api('/api/purchase-invoices', {
    method: 'POST',
    body: {
      partyId: WEAVER, supplierInvoiceNo: `DCGHOST-${stamp}`,
      invoiceDate: '2026-09-01', kind: 'grey',
      sourceDoc: 'grey_inward', sourceId: '33333333-0000-0000-0000-999999999999',
      lines: [{ hsnCode: '551311', description: 'Galaxy grey', qty: 10, rate: 30.5, gstRate: 5 }]
    }
  });
  assert.equal(noSuchDoc.status, 400, JSON.stringify(noSuchDoc.body));
});

test('the mill can see what it has taken in and nobody has billed yet', async () => {
  const r = await api('/api/reports/unbilled-receipts?limit=200');
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const mine = (r.body as any[]).find(x => x.challan_no === `DCX-${stamp}`);
  assert.ok(mine, 'an unbilled delivery is missing from the report');
  assert.equal(paise(mine.unbilled_value), 30500, '10 mtr at 30.50 is 305.00 unbilled');
  assert.equal(mine.kind, 'grey');

  // The first delivery in this file was billed in full, so it has cleared.
  const billed = (r.body as any[]).find(x => x.challan_no === `DC-${stamp}`);
  assert.equal(billed, undefined, 'a fully billed delivery is still shown as unbilled');
});
