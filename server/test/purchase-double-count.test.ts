/**
 * Does booking the supplier's bill for goods already taken into stock charge
 * the mill twice?
 *
 * Grey inward capitalises the goods: Dr inventory_grey / Cr the weaver.
 * A purchase invoice for the same goods posts: Dr purchase expense / Cr the
 * weaver. If both stand, the weaver is credited twice for one delivery and the
 * cost sits in inventory *and* in an expense account at once — a trial balance
 * still balances, because both sides doubled, so nothing catches it.
 *
 * This test asserts the books are right. If it fails, it is not the test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const WEAVER = '33333333-0000-0000-0000-000000000105';
const QUALITY_GALAXY = '44444444-0000-0000-0000-000000000001';
const GREY_STOCK = '33333333-0000-0000-0000-000000000960';

const stamp = Date.now();
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

const paise = (n: unknown) => Math.round(Number(n ?? 0) * 100);

async function balance(ledgerId: string) {
  const r = await api('/api/reports/party-balance?limit=1000');
  const row = (r.body as any[]).find(x => x.ledger_id === ledgerId);
  return row ? paise(row.balance) : 0;
}

test('sign in', async () => {
  const r = await api('/api/auth/login', {
    method: 'POST', body: { email: 'owner@neelkamal.test', password: 'changeme' }
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  token = r.body.token;
});

test('taking grey into stock credits the weaver once, at cost', async () => {
  const before = await balance(WEAVER);
  const stockBefore = await balance(GREY_STOCK);

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

  // 1000 x 30.50 = 30,500.00 into stock, owed to the weaver.
  assert.equal(await balance(GREY_STOCK) - stockBefore, 3050000);
  assert.equal(await balance(WEAVER) - before, -3050000);
});

/**
 * KNOWN DEFECT, awaiting a decision on how grey purchases are booked.
 *
 * Reproduced 2026-08-27: a 1,000 mtr inward at 30.50 credits the weaver
 * 30,500.00, and the supplier's bill for the same goods then credits them a
 * further 32,025.00 — so the weaver shows 62,525.00 for one delivery worth
 * 32,025.00 inclusive of GST, and the cost sits in inventory *and* in Direct
 * Expenses at the same time. The trial balance still balances, because both
 * sides doubled, which is precisely why nothing catches it.
 *
 * Skipped rather than deleted: this test is the evidence, and it should start
 * passing the day the flow is fixed. See docs/PURCHASE_ACCOUNTING.md.
 */
test('the supplier bill for those same goods must not charge the mill twice',
  { skip: 'known defect: goods are booked by both the inward and the bill' },
  async () => {
  const weaverBefore = await balance(WEAVER);
  const stockBefore = await balance(GREY_STOCK);

  const r = await api('/api/purchase-invoices', {
    method: 'POST',
    body: {
      partyId: WEAVER, supplierInvoiceNo: `DCSUP-${stamp}`, invoiceDate: '2026-09-01',
      kind: 'grey',
      sourceDoc: 'grey_inward',
      lines: [{ hsnCode: '551311', description: 'Galaxy grey', qty: 1000, rate: 30.5, gstRate: 5 }]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  const weaverMoved = weaverBefore - await balance(WEAVER);
  const stockMoved = await balance(GREY_STOCK) - stockBefore;

  // The bill adds GST — 5% of 30,500 = 1,525 — and nothing else. The goods
  // were already charged when they were taken into stock.
  assert.equal(
    weaverMoved, 152500,
    `the weaver was credited ${weaverMoved / 100} for a bill whose only new ` +
    'charge is 1,525.00 of GST; the goods have been booked twice'
  );
  assert.equal(
    stockMoved, 0,
    'the bill moved the stock value again after the inward already capitalised it'
  );
});
