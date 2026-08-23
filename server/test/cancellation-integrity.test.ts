import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const WEAVER = '33333333-0000-0000-0000-000000000105';
const PROCESS = '33333333-0000-0000-0000-000000000202';
const QUALITY = '44444444-0000-0000-0000-000000000001';
const stamp = Date.now();
const barcode = `CX${stamp}`;
let owner = '';
let store = '';
let issueId = '';
let receiptId = '';

async function api(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json',
      ...(opts.token ?? owner ? { authorization: `Bearer ${opts.token ?? owner}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function piece() {
  const rows = await api(`/api/pieces?barcode=${barcode}`);
  return rows.body[0];
}

test('cancellation integrity setup posts one valued dyeing lifecycle', async () => {
  for (const [email, assign] of [
    ['owner@neelkamal.test', (v: string) => { owner = v; }],
    ['store@neelkamal.test', (v: string) => { store = v; }]
  ] as const) {
    const login = await api('/api/auth/login', { method: 'POST', body: { email, password: 'changeme' }, token: '' });
    assert.equal(login.status, 200);
    assign(login.body.token);
  }
  const inward = await api('/api/grey-inwards', { method: 'POST', token: store, body: {
    partyId: WEAVER, entryDate: '2026-10-01', challanNo: `CX-GIN-${stamp}`,
    challanDate: '2026-10-01', lotNo: `CX-${stamp}`, lines: [{ qualityId: QUALITY,
      gradeCode: 'A', barcode, lotNo: `CX-${stamp}`, receivedQty: 100, checkedQty: 100, rate: 30 }]
  } });
  assert.equal(inward.status, 201, JSON.stringify(inward.body));
  const issue = await api('/api/dyeing-issues', { method: 'POST', token: store, body: {
    processHouseId: PROCESS, entryDate: '2026-10-02', challanNo: `CX-DI-${stamp}`,
    challanDate: '2026-10-02', lotNo: `CX-${stamp}`, jobRate: 18, barcodes: [barcode]
  } });
  assert.equal(issue.status, 201, JSON.stringify(issue.body));
  issueId = issue.body.id;
  const receipt = await api('/api/dyeing-receipts', { method: 'POST', token: store, body: {
    processHouseId: PROCESS, entryDate: '2026-10-05', challanNo: `CX-DR-${stamp}`,
    challanDate: '2026-10-05', lines: [{ barcode, receivedQty: 95, finishGrade: 'B', jobRate: 18 }]
  } });
  assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
  receiptId = receipt.body.id;
  const p = await piece();
  assert.equal(p.status, 'received_finish');
  assert.equal(Number(p.cost), 4710);
});

test('cancelling a dyeing receipt restores process custody, grey metres, and grey-only value', async () => {
  const cancelled = await api(`/api/documents/dyeing_receipt/${receiptId}/cancel`, {
    method: 'POST', body: { reason: 'process-house receipt entered with wrong measurements' }
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.reversedVouchers, 1);
  assert.equal(cancelled.body.revertedPieces, 1);
  const p = await piece();
  assert.equal(p.status, 'issued_to_dyeing');
  assert.equal(Number(p.current_qty), 100);
  assert.equal(p.finish_qty, null);
  assert.equal(Number(p.cost), 3000);
  assert.equal(p.held_by, 'Prayag Texprint Llp');
});

test('the corrected receipt can be posted again without double-capitalising jobwork', async () => {
  const corrected = await api('/api/dyeing-receipts', { method: 'POST', token: store, body: {
    processHouseId: PROCESS, entryDate: '2026-10-06', challanNo: `CX-DR2-${stamp}`,
    challanDate: '2026-10-06', lines: [{ barcode, receivedQty: 94, finishGrade: 'A', jobRate: 17 }]
  } });
  assert.equal(corrected.status, 201, JSON.stringify(corrected.body));
  const p = await piece();
  assert.equal(p.status, 'received_finish');
  assert.equal(Number(p.current_qty), 94);
  assert.equal(Number(p.cost), 4598);
  assert.equal(p.held_by, null);

  const trial = await api('/api/reports/trial-balance');
  const drift = trial.body.reduce((sum: number, row: any) => sum + Number(row.balance), 0);
  assert.ok(Math.abs(drift) < 0.01, `trial balance drifted by ${drift}`);
});

test('a dyeing issue cannot be cancelled after a corrected live receipt', async () => {
  const blocked = await api(`/api/documents/dyeing_issue/${issueId}/cancel`, {
    method: 'POST', body: { reason: 'attempted out-of-order reversal' }
  });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /goods have already come back from dyeing/i);
});
