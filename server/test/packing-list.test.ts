import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const WEAVER = '33333333-0000-0000-0000-000000000105';
const PROCESS_HOUSE = '33333333-0000-0000-0000-000000000202';
const CUSTOMER = '33333333-0000-0000-0000-000000000701';
const TRANSPORT = '33333333-0000-0000-0000-000000000802';
const QUALITY = '44444444-0000-0000-0000-000000000001';
const stamp = Date.now();
const barcode = `PL${stamp}`;
let token = '';
let dispatchId = '';

async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('packing-list setup makes one finish piece and posts a customer dispatch', async () => {
  const login = await api('/api/auth/login', { method: 'POST',
    body: { email: 'owner@neelkamal.test', password: 'changeme' } });
  assert.equal(login.status, 200);
  token = login.body.token;

  const inward = await api('/api/grey-inwards', { method: 'POST', body: {
    partyId: WEAVER, entryDate: '2026-12-01', challanNo: `PL-GIN-${stamp}`,
    challanDate: '2026-12-01', lotNo: `PL-LOT-${stamp}`, lines: [{
      qualityId: QUALITY, gradeCode: 'A', barcode, lotNo: `PL-LOT-${stamp}`,
      receivedQty: 100, checkedQty: 100, rate: 30
    }]
  } });
  assert.equal(inward.status, 201, JSON.stringify(inward.body));
  const issue = await api('/api/dyeing-issues', { method: 'POST', body: {
    processHouseId: PROCESS_HOUSE, entryDate: '2026-12-02', challanNo: `PL-DI-${stamp}`,
    challanDate: '2026-12-02', lotNo: `PL-LOT-${stamp}`, jobRate: 10, barcodes: [barcode]
  } });
  assert.equal(issue.status, 201, JSON.stringify(issue.body));
  const receipt = await api('/api/dyeing-receipts', { method: 'POST', body: {
    processHouseId: PROCESS_HOUSE, entryDate: '2026-12-05', challanNo: `PL-DR-${stamp}`,
    challanDate: '2026-12-05', lines: [{ barcode, receivedQty: 95, finishGrade: 'A', jobRate: 10 }]
  } });
  assert.equal(receipt.status, 201, JSON.stringify(receipt.body));

  const dispatched = await api('/api/dispatches', { method: 'POST', body: {
    partyId: CUSTOMER, challanNo: `PL-DC-${stamp}`, challanDate: '2026-12-06',
    transportId: TRANSPORT, lrNo: `LR-${stamp}`, vehicleNo: 'MH04AB1234',
    lines: [{ barcode, rate: 80 }]
  } });
  assert.equal(dispatched.status, 201, JSON.stringify(dispatched.body));
  dispatchId = dispatched.body.id;
  assert.equal(dispatched.body.pieces, 1);
  assert.equal(Number(dispatched.body.value), 7600);
});

test('dispatch register exposes the source document for packing', async () => {
  const register = await api(`/api/dispatches?q=${encodeURIComponent(`PL-DC-${stamp}`)}`);
  assert.equal(register.status, 200);
  assert.equal(register.body.rows.length, 1);
  assert.equal(register.body.rows[0].id, dispatchId);
  assert.equal(register.body.rows[0].party_name, 'Supreme Textile And Garments');
  assert.equal(Number(register.body.rows[0].pieces), 1);
});

test('packing list is piece-wise and agrees exactly with the dispatch', async () => {
  const printed = await api(`/api/dispatches/${dispatchId}/packing-list`);
  assert.equal(printed.status, 200, JSON.stringify(printed.body));
  assert.equal(printed.body.challan_no, `PL-DC-${stamp}`);
  assert.equal(printed.body.customer_name, 'Supreme Textile And Garments');
  assert.equal(printed.body.delivery_city, 'Madurai');
  assert.equal(printed.body.transport_name, 'Uttam Roadways Pvt. Ltd.');
  assert.equal(printed.body.vehicle_no, 'MH04AB1234');
  assert.equal(printed.body.lines.length, 1);
  assert.equal(printed.body.lines[0].barcode, barcode);
  assert.equal(printed.body.lines[0].quality, 'Galaxy');
  assert.equal(printed.body.lines[0].lot_no, `PL-LOT-${stamp}`);
  assert.equal(Number(printed.body.total_qty), 95);
  assert.equal(Number(printed.body.total_value), 7600);
});

test('a cancelled dispatch remains auditable and prints a cancelled packing list', async () => {
  const cancelled = await api(`/api/documents/dispatch/${dispatchId}/cancel`, { method: 'POST',
    body: { reason: 'truck allocation changed before departure' } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const printed = await api(`/api/dispatches/${dispatchId}/packing-list`);
  assert.equal(printed.status, 200);
  assert.equal(printed.body.status, 'cancelled');
  assert.equal(printed.body.lines[0].barcode, barcode);
});
