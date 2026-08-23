import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const WEAVER = '33333333-0000-0000-0000-000000000105';
const QUALITY = '44444444-0000-0000-0000-000000000001';
const stamp = Date.now();
let owner = '';
let viewer = '';
let orderId = '';
let orderNo = '';
let poLineId = '';
let inwardId = '';

async function api(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('purchase order setup signs in owner and read-only viewer', async () => {
  for (const [email, assign] of [
    ['owner@neelkamal.test', (token: string) => { owner = token; }],
    ['viewer@neelkamal.test', (token: string) => { viewer = token; }]
  ] as const) {
    const login = await api('/api/auth/login', { method: 'POST', body: { email, password: 'changeme' } });
    assert.equal(login.status, 200);
    assign(login.body.token);
  }
});

test('a viewer cannot book a grey purchase order', async () => {
  const denied = await api('/api/grey-purchase-orders', {
    method: 'POST', token: viewer,
    body: { partyId: WEAVER, orderDate: '2026-09-01', lines: [
      { qualityId: QUALITY, gradeCode: 'A', pcs: 1, cutLength: 100, qty: 100, rate: 30 }
    ] }
  });
  assert.equal(denied.status, 403);
});

test('an omitted purchase-order rate resolves from the valid rate master', async () => {
  const made = await api('/api/grey-purchase-orders', {
    method: 'POST', token: owner,
    body: {
      partyId: WEAVER, orderDate: '2026-09-01', remarks: `master rate ${stamp}`,
      lines: [{ qualityId: QUALITY, gradeCode: 'A', pcs: 1, cutLength: 10, qty: 10 }]
    }
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const listed = await api(`/api/grey-purchase-orders?q=${encodeURIComponent(made.body.orderNo)}`, { token: owner });
  assert.equal(Number(listed.body.rows[0].lines[0].rate), 30.5);
  assert.equal(Number(listed.body.rows[0].lines[0].amount), 305);
});

test('owner books, lists, and prints a purchase order with exact totals', async () => {
  const made = await api('/api/grey-purchase-orders', {
    method: 'POST', token: owner,
    body: {
      partyId: WEAVER, orderDate: '2026-09-01', deliveryDate: '2026-09-15',
      deliveryDays: 14, paymentTerms: '30 days after receipt', remarks: `PO test ${stamp}`,
      lines: [{ qualityId: QUALITY, gradeCode: 'A', pcs: 2, cutLength: 100, qty: 200, rate: 30 }]
    }
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  orderId = made.body.id;
  orderNo = made.body.orderNo;

  const listed = await api(`/api/grey-purchase-orders?q=${encodeURIComponent(orderNo)}`, { token: owner });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.rows.length, 1);
  assert.equal(listed.body.rows[0].lines.length, 1);
  poLineId = listed.body.rows[0].lines[0].id;
  assert.equal(Number(listed.body.rows[0].lines[0].qty), 200);
  assert.equal(Number(listed.body.rows[0].lines[0].received_qty), 0);

  const printed = await api(`/api/grey-purchase-orders/${orderId}/print`, { token: owner });
  assert.equal(printed.status, 200);
  assert.equal(printed.body.order_no, orderNo);
  assert.equal(Number(printed.body.total), 6000);
  assert.match(printed.body.amount_in_words, /Six Thousand/i);
  assert.match(printed.body.lines[0].hsn_code, /^\d{4,8}$/);
});

test('a grey inward linked to the order updates its receipt balance', async () => {
  assert.ok(poLineId, 'purchase-order line id must be returned to the receiving workflow');
  const barcode = `PO${stamp}`;
  const inward = await api('/api/grey-inwards', {
    method: 'POST', token: owner,
    body: {
      partyId: WEAVER, entryDate: '2026-09-05', challanNo: `CH-${stamp}`,
      challanDate: '2026-09-05', lotNo: `LOT-${stamp}`,
      lines: [{ poLineId, qualityId: QUALITY, gradeCode: 'A', barcode,
        lotNo: `LOT-${stamp}`, receivedQty: 100, checkedQty: 100, rate: 30 }]
    }
  });
  assert.equal(inward.status, 201, JSON.stringify(inward.body));
  inwardId = inward.body.id;

  const listed = await api(`/api/grey-purchase-orders?q=${encodeURIComponent(orderNo)}`, { token: owner });
  assert.equal(Number(listed.body.rows[0].lines[0].received_qty), 100);
  assert.equal(Number(listed.body.rows[0].lines[0].qty) - Number(listed.body.rows[0].lines[0].received_qty), 100);
});

test('a purchase order with live receipts cannot be cancelled', async () => {
  const blocked = await api(`/api/documents/grey_purchase_order/${orderId}/cancel`, {
    method: 'POST', token: owner, body: { reason: 'supplier order entered twice' }
  });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /cancel the linked grey inward first/i);
});

test('cancelling the linked inward reopens the PO balance before the PO can be cancelled', async () => {
  const reversed = await api(`/api/documents/grey_inward/${inwardId}/cancel`, {
    method: 'POST', token: owner, body: { reason: 'receipt was booked against the wrong purchase order' }
  });
  assert.equal(reversed.status, 200, JSON.stringify(reversed.body));
  const listed = await api(`/api/grey-purchase-orders?q=${encodeURIComponent(orderNo)}`, { token: owner });
  assert.equal(Number(listed.body.rows[0].lines[0].received_qty), 0);

  const cancelled = await api(`/api/documents/grey_purchase_order/${orderId}/cancel`, {
    method: 'POST', token: owner, body: { reason: 'supplier order entered twice' }
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
});
