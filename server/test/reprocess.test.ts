import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const WEAVER = '33333333-0000-0000-0000-000000000105';
const PROCESS_HOUSE = '33333333-0000-0000-0000-000000000202';
const QUALITY = '44444444-0000-0000-0000-000000000001';
const stamp = Date.now();
const barcode = `RP${stamp}`;
const tokens: Record<string, string> = {};
let reprocessId = '';
let receiptId = '';
let receiptNo = '';

async function api(path: string, opts: { method?: string; body?: unknown; as?: string } = {}) {
  const token = tokens[opts.as ?? 'owner'] ?? '';
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function piece() {
  const rows = await api('/api/pieces?limit=100000');
  return rows.body.find((row: any) => row.barcode === barcode);
}

test('reprocess setup creates one valued finish piece', async () => {
  for (const who of ['owner', 'store']) {
    const login = await api('/api/auth/login', { method: 'POST',
      body: { email: `${who}@neelkamal.test`, password: 'changeme' } });
    assert.equal(login.status, 200); tokens[who] = login.body.token;
  }
  const inward = await api('/api/grey-inwards', { method: 'POST', as: 'store', body: {
    partyId: WEAVER, entryDate: '2026-11-01', challanNo: `GIN-${stamp}`,
    challanDate: '2026-11-01', lotNo: `LOT-${stamp}`, lines: [{
      qualityId: QUALITY, gradeCode: 'A', barcode, lotNo: `LOT-${stamp}`,
      receivedQty: 100, checkedQty: 100, rate: 30
    }]
  } });
  assert.equal(inward.status, 201, JSON.stringify(inward.body));
  const issue = await api('/api/dyeing-issues', { method: 'POST', as: 'store', body: {
    processHouseId: PROCESS_HOUSE, entryDate: '2026-11-02', challanNo: `DI-${stamp}`,
    challanDate: '2026-11-02', lotNo: `LOT-${stamp}`, jobRate: 10, barcodes: [barcode]
  } });
  assert.equal(issue.status, 201, JSON.stringify(issue.body));
  const receipt = await api('/api/dyeing-receipts', { method: 'POST', as: 'store', body: {
    processHouseId: PROCESS_HOUSE, entryDate: '2026-11-05', challanNo: `DR-${stamp}`,
    challanDate: '2026-11-05', lines: [{ barcode, receivedQty: 95, finishGrade: 'A', jobRate: 10 }]
  } });
  assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
  const p = await piece();
  assert.equal(p.status, 'received_finish');
  assert.equal(Number(p.current_qty), 95);
  assert.equal(Number(p.cost), 3950);
});

test('reprocess issue preserves value and puts custody at the process house', async () => {
  const issued = await api('/api/dyeing-reprocesses', { method: 'POST', as: 'store', body: {
    processHouseId: PROCESS_HOUSE, issueDate: '2026-11-06', challanNo: `RP-${stamp}`,
    challanDate: '2026-11-06', reason: 'shade mismatch; correct to approved lab dip', barcodes: [barcode]
  } });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  reprocessId = issued.body.id;
  assert.equal(Number(issued.body.qty), 95);
  const p = await piece();
  assert.equal(p.status, 'reprocess_at_process_house');
  assert.equal(Number(p.current_qty), 95);
  assert.equal(Number(p.cost), 3950);

  const processStock = await api('/api/reports/process-stock');
  assert.ok(processStock.body.some((row: any) => row.stage === 'Reprocess' && row.process_house.includes('Prayag')));
  const printed = await api(`/api/dyeing-reprocesses/${reprocessId}/print`);
  assert.equal(printed.status, 200);
  assert.equal(printed.body.lines[0].barcode, barcode);
  assert.equal(Number(printed.body.total_qty), 95);
});

test('reprocess receipt enforces the configured shrinkage boundary', async () => {
  const bad = await api('/api/dyeing-reprocess-receipts', { method: 'POST', as: 'store', body: {
    reprocessId, receiptDate: '2026-11-08', challanNo: `BAD-${stamp}`, challanDate: '2026-11-08',
    lines: [{ barcode, receivedQty: 70, additionalRate: 2, finishGrade: 'A' }]
  } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /shrinkage outside policy/i);
});

test('incremental charge is held and stock does not move before approval', async () => {
  const made = await api('/api/dyeing-reprocess-receipts', { method: 'POST', as: 'store', body: {
    reprocessId, receiptDate: '2026-11-08', challanNo: `RR-${stamp}`, challanDate: '2026-11-08',
    lines: [{ barcode, receivedQty: 93, additionalRate: 2, finishGrade: 'B' }]
  } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.status, 'pending_approval');
  assert.equal(Number(made.body.amount), 186);
  receiptId = made.body.id; receiptNo = made.body.receiptNo;
  const p = await piece();
  assert.equal(p.status, 'reprocess_at_process_house');
  assert.equal(Number(p.current_qty), 95);
  assert.equal(Number(p.cost), 3950);
  const pending = await api('/api/approvals/pending');
  assert.ok(pending.body.some((row: any) => row.doc_type === 'dyeing_reprocess_receipt' && row.doc_no === receiptNo));
});

test('maker cannot approve; a different owner posts metres and incremental cost atomically', async () => {
  const maker = await api(`/api/approvals/dyeing_reprocess_receipt/${receiptId}/approve`, {
    method: 'POST', as: 'store', body: { note: '' }
  });
  assert.equal(maker.status, 400);
  assert.match(maker.body.error, /needs the (owner|accounts) role|raised by you/i);

  const approved = await api(`/api/approvals/dyeing_reprocess_receipt/${receiptId}/approve`, {
    method: 'POST', as: 'owner', body: { note: 'shade and rate checked' }
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.ok(approved.body.voucherNo);
  const p = await piece();
  assert.equal(p.status, 'received_finish');
  assert.equal(Number(p.current_qty), 93);
  assert.equal(Number(p.cost), 4136);
  assert.equal(p.grade_code, 'B');

  const register = await api('/api/dyeing-reprocesses?limit=100');
  const row = register.body.rows.find((item: any) => item.id === reprocessId);
  assert.equal(row.status, 'closed');
  assert.equal(row.lines[0].receipt_status, 'approved');
});

test('cancelling an approved reprocess receipt restores custody, metres, and cost', async () => {
  const cancelled = await api(`/api/documents/dyeing_reprocess_receipt/${receiptId}/cancel`, {
    method: 'POST', as: 'owner', body: { reason: 'process house entered the wrong receipt challan' }
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.reversedVouchers, 1);
  assert.equal(cancelled.body.revertedPieces, 1);
  const p = await piece();
  assert.equal(p.status, 'reprocess_at_process_house');
  assert.equal(Number(p.current_qty), 95);
  assert.equal(Number(p.cost), 3950);
  assert.equal(p.held_by, 'Prayag Texprint Llp');
  const register = await api('/api/dyeing-reprocesses?limit=100');
  const row = register.body.rows.find((item: any) => item.id === reprocessId);
  assert.equal(row.status, 'approved');
  assert.equal(row.lines[0].receipt_status, null);
});

test('the outstanding reprocess challan can then be cancelled without losing value', async () => {
  const cancelled = await api(`/api/documents/dyeing_reprocess/${reprocessId}/cancel`, {
    method: 'POST', as: 'owner', body: { reason: 'correction work cancelled by the mill' }
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.reversedVouchers, 0);
  assert.equal(cancelled.body.revertedPieces, 1);
  const p = await piece();
  assert.equal(p.status, 'received_finish');
  assert.equal(Number(p.current_qty), 95);
  assert.equal(Number(p.cost), 3950);
  assert.equal(p.held_by, null);
  const register = await api('/api/dyeing-reprocesses?limit=100');
  const row = register.body.rows.find((item: any) => item.id === reprocessId);
  assert.equal(row.status, 'cancelled');
});
