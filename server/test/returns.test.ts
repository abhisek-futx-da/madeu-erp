import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4111';
const tokens: Record<string, string> = {};
const PARTY_WEAVER = '33333333-0000-0000-0000-000000000105';
const QUALITY_GALAXY = '44444444-0000-0000-0000-000000000001';
const stamp = Date.now();

async function api(
  path: string,
  opts: { method?: string; body?: unknown; as?: string } = {}
) {
  const token = tokens[opts.as ?? 'store'] ?? '';
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

async function inward(barcode: string) {
  const r = await api('/api/grey-inwards', {
    method: 'POST', as: 'owner',
    body: {
      partyId: PARTY_WEAVER,
      entryDate: '2026-08-21',
      challanNo: `SPL-${barcode}`,
      challanDate: '2026-08-21',
      lotNo: `LOT-${stamp}`,
      lines: [{
        qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode, lotNo: `LOT-${stamp}`,
        receivedQty: 100, checkedQty: 100, rate: 45.5
      }]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
}

test('sign in', async () => {
  for (const who of ['owner', 'store', 'accounts', 'viewer']) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${who}@neelkamal.test`, password: 'changeme' })
    });
    const body = await r.json() as any;
    assert.equal(r.status, 200, JSON.stringify(body));
    tokens[who] = body.token;
  }
});

test('a grey return deducts stock and posts a debit note to the weaver', async () => {
  await inward('RET-TEST-001');
  const pieces = await api('/api/pieces', { as: 'owner' });
  const p1 = pieces.body.find((p: any) => p.status === 'grey_in_stock' && p.current_qty > 0);
  assert.ok(p1, 'need a grey piece');

  const res = await api('/api/grey-returns', {
    method: 'POST', as: 'owner',
    body: {
      weaverId: PARTY_WEAVER,
      entryDate: '2024-04-01',
      challanNo: 'RET-001',
      reason: 'defective weaving',
      lines: [
        { barcode: p1.barcode, qty: Number(p1.current_qty), rate: 45.5 }
      ]
    }
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.entryNo, 'must return entry no');
  assert.equal(res.body.status, 'pending_approval', 'financial returns need a second person');
  const submitHistory = await api('/api/approvals/history', { as: 'owner' });
  assert.equal(submitHistory.status, 200, JSON.stringify(submitHistory.body));
  assert.ok(submitHistory.body.some((event: any) =>
    event.doc_type === 'grey_return' && event.doc_id === res.body.id && event.action === 'submitted'
  ), 'the maker submission must be auditable');

  const held = await api('/api/pieces', { as: 'owner' });
  assert.equal(held.body.find((p: any) => p.barcode === p1.barcode)?.status, 'grey_in_stock',
    'held return must not move the piece');
  const approved = await api(`/api/approvals/grey_return/${res.body.id}/approve`, {
    method: 'POST', as: 'accounts', body: { note: 'physical defect confirmed' }
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  // Verify stock left
  const after = await api('/api/pieces', { as: 'owner' });
  const p2 = after.body.find((p: any) => p.barcode === p1.barcode);
  assert.equal(p2.status, 'returned_to_weaver', 'piece must be marked returned');
  assert.equal(Number(p2.current_qty), 0, 'piece qty must be zeroed');

  // Cancel it
  const cancelRes = await api('/api/documents/grey_return/' + res.body.id + '/cancel', {
    method: 'POST', as: 'accounts',
    body: { reason: 'mistake' }
  });
  assert.equal(cancelRes.status, 200, JSON.stringify(cancelRes.body));

  // Verify stock came back
  const restored = await api('/api/pieces', { as: 'owner' });
  const p3 = restored.body.find((p: any) => p.barcode === p1.barcode);
  assert.equal(p3.status, 'grey_in_stock', 'piece must return to stock');
  assert.equal(Number(p3.current_qty), Number(p1.current_qty), 'piece qty must be restored');
});

test('cancelling an unapproved return drops its held voucher and cannot later post it', async () => {
  await inward('RET-TEST-CANCELLED');
  const pieces = await api('/api/pieces', { as: 'owner' });
  const piece = pieces.body.find((p: any) => p.barcode === 'RET-TEST-CANCELLED');
  assert.ok(piece, 'need the newly inwarded piece');

  const submitted = await api('/api/grey-returns', {
    method: 'POST', as: 'owner',
    body: {
      weaverId: PARTY_WEAVER, entryDate: '2026-08-25', challanNo: 'RET-CANCELLED',
      reason: 'entered on the wrong sheet',
      lines: [{ barcode: piece.barcode, qty: Number(piece.current_qty) }]
    }
  });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
  assert.equal(submitted.body.status, 'pending_approval');

  const cancelled = await api(`/api/documents/grey_return/${submitted.body.id}/cancel`, {
    method: 'POST', as: 'accounts', body: { reason: 'wrong sheet, void before approval' }
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.droppedHeldVouchers, 1,
    'cancellation must remove the accounting proposal rather than leave it held');

  const stillInStock = await api(`/api/pieces?barcode=${piece.barcode}`, { as: 'owner' });
  assert.equal(stillInStock.body[0]?.status, 'grey_in_stock', 'a held return must never move stock');
  const laterApproval = await api(`/api/approvals/grey_return/${submitted.body.id}/approve`, {
    method: 'POST', as: 'accounts', body: { note: 'must not be postable after cancellation' }
  });
  assert.equal(laterApproval.status, 400, JSON.stringify(laterApproval.body));
  assert.match(String(laterApproval.body.error), /cancelled/);
  const history = await api('/api/approvals/history', { as: 'accounts' });
  assert.ok(history.body.some((event: any) =>
    event.doc_type === 'grey_return' && event.doc_id === submitted.body.id && event.action === 'cancelled'
  ), 'the cancellation must be visible in the decision history');
});

const PROCESS_HOUSE = '33333333-0000-0000-0000-000000000202';

async function dyeingIssueAndReceipt(barcode: string) {
  // We need to issue it to dyeing
  let r = await api('/api/dyeing-issues', {
    method: 'POST', as: 'owner',
    body: {
      processHouseId: PROCESS_HOUSE,
      entryDate: '2026-08-22',
      challanNo: `ISS-${barcode}`,
      challanDate: '2026-08-22',
      barcodes: [barcode]
    }
  });
  assert.equal(r.status, 201, 'issue to dyeing failed: ' + JSON.stringify(r.body));

  // Then receive it
  r = await api('/api/dyeing-receipts', {
    method: 'POST', as: 'owner',
    body: {
      processHouseId: PROCESS_HOUSE,
      entryDate: '2026-08-23',
      challanNo: `REC-${barcode}`,
      challanDate: '2026-08-23',
      lines: [{ barcode, receivedQty: 100, finishGrade: 'FRESH', jobRate: 15 }]
    }
  });
  assert.equal(r.status, 201, 'receive from dyeing failed: ' + JSON.stringify(r.body));
}

test('a dyeing return deducts stock and posts a debit note to the process house', async () => {
  await inward('RET-TEST-002');
  await dyeingIssueAndReceipt('RET-TEST-002');

  const pieces = await api('/api/pieces', { as: 'owner' });
  const p1 = pieces.body.find((p: any) => p.status === 'received_finish' && p.barcode === 'RET-TEST-002');
  assert.ok(p1, 'need a finish piece');

  const res = await api('/api/dyeing-returns', {
    method: 'POST', as: 'owner',
    body: {
      processHouseId: PROCESS_HOUSE,
      entryDate: '2026-08-24',
      challanNo: 'DRET-001',
      reason: 'color bleeding',
      lines: [
        { barcode: p1.barcode, qty: Number(p1.current_qty), jobworkRate: 15 }
      ]
    }
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.entryNo, 'must return entry no');
  assert.equal(res.body.status, 'pending_approval', 'financial returns need a second person');

  const held = await api('/api/pieces', { as: 'owner' });
  assert.equal(held.body.find((p: any) => p.barcode === p1.barcode)?.status, 'received_finish',
    'held return must not move the piece');
  const approved = await api(`/api/approvals/dyeing_return/${res.body.id}/approve`, {
    method: 'POST', as: 'accounts', body: { note: 'colour defect confirmed' }
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  // Verify stock left
  const after = await api('/api/pieces', { as: 'owner' });
  const p2 = after.body.find((p: any) => p.barcode === p1.barcode);
  assert.equal(p2.status, 'returned_to_process_house', 'piece must be marked returned');
  assert.equal(Number(p2.current_qty), 0, 'piece qty must be zeroed');

  // Cancel it
  const cancelRes = await api('/api/documents/dyeing_return/' + res.body.id + '/cancel', {
    method: 'POST', as: 'owner',
    body: { reason: 'mistake' }
  });
  assert.equal(cancelRes.status, 200, 'cancellation should succeed: ' + JSON.stringify(cancelRes.body));

  // Verify stock came back
  const restored = await api('/api/pieces', { as: 'owner' });
  const p3 = restored.body.find((p: any) => p.barcode === p1.barcode);
  assert.equal(p3.status, 'received_finish', 'piece must return to finish stock');
  assert.equal(Number(p3.current_qty), Number(p1.current_qty), 'piece qty must be restored');
});
