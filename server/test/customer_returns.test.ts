
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4111/api';
const WEAVER = '33333333-0000-0000-0000-000000000105';
const PROCESS_HOUSE = '33333333-0000-0000-0000-000000000202';
const CUSTOMER = '33333333-0000-0000-0000-000000000701';
const OTHER_CUSTOMER = '33333333-0000-0000-0000-000000000629';
const QUALITY = '44444444-0000-0000-0000-000000000001';
const stamp = Date.now().toString().slice(-7);
const barcode = `CR-${stamp}`;
let ownerToken = '';
let accountsToken = '';

const number = (value: unknown) => Number(value ?? 0);

async function api(path: string, token: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await response.json();
  return { response, json };
}

test('customer return is tied to the original invoice and cancellation restores dispatched stock', async () => {
  const ownerLogin = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@neelkamal.test', password: 'changeme' }),
  });
  ownerToken = (await ownerLogin.json() as { token: string }).token;
  const accountsLogin = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'accounts@neelkamal.test', password: 'changeme' }),
  });
  accountsToken = (await accountsLogin.json() as { token: string }).token;

  let call = await api('/grey-inwards', ownerToken, 'POST', {
    partyId: WEAVER, entryDate: '2026-08-22', challanNo: `CR-GI-${stamp}`,
    challanDate: '2026-08-22', lotNo: `CR-LOT-${stamp}`,
    lines: [{ qualityId: QUALITY, gradeCode: 'LUMP', barcode, lotNo: `CR-LOT-${stamp}`,
      receivedQty: 10, checkedQty: 10, rate: 100 }],
  });
  assert.equal(call.response.status, 201, JSON.stringify(call.json));
  await api('/dyeing-issues', ownerToken, 'POST', {
    entryDate: '2026-08-22', challanNo: `CR-DI-${stamp}`, challanDate: '2026-08-22',
    processHouseId: PROCESS_HOUSE, barcodes: [barcode],
  }).then(({ response, json }) => assert.equal(response.status, 201, JSON.stringify(json)));
  await api('/dyeing-receipts', ownerToken, 'POST', {
    entryDate: '2026-08-22', challanNo: `CR-DR-${stamp}`, challanDate: '2026-08-22',
    processHouseId: PROCESS_HOUSE, lines: [{ barcode, receivedQty: 10, finishGrade: 'FRESH', jobRate: 15 }],
  }).then(({ response, json }) => assert.equal(response.status, 201, JSON.stringify(json)));
  call = await api('/dispatches', ownerToken, 'POST', {
    partyId: CUSTOMER, challanNo: `CR-DC-${stamp}`, challanDate: '2026-08-22',
    lines: [{ barcode, rate: 150 }],
  });
  assert.equal(call.response.status, 201, JSON.stringify(call.json));
  const dispatchId = call.json.id as string;
  call = await api('/sales-invoices', ownerToken, 'POST', {
    dispatchId, invoiceDate: '2026-08-22', placeOfSupply: '24',
  });
  assert.equal(call.response.status, 201, JSON.stringify(call.json));
  const invoiceId = call.json.id as string;

  call = await api('/reports/gstr3b-outward', ownerToken);
  const beforeReturn = (call.json as Array<any>).find(row => row.return_period === '08-2026');
  assert.ok(beforeReturn, 'the original invoice must appear in GSTR-3B');

  call = await api('/customer-returns', ownerToken, 'POST', {
    challanNo: `CR-RET-WRONG-${stamp}`, entryDate: '2026-08-22', againstInvoiceId: invoiceId,
    customerId: OTHER_CUSTOMER, reason: 'Wrong party must be refused', lines: [{ barcode, qty: 10 }],
  });
  assert.equal(call.response.status, 400, JSON.stringify(call.json));

  call = await api('/customer-returns', ownerToken, 'POST', {
    challanNo: `CR-RET-${stamp}`, entryDate: '2026-08-22', againstInvoiceId: invoiceId,
    customerId: CUSTOMER, reason: 'Customer returned the complete roll', lines: [{ barcode, qty: 10, rate: 1 }],
  });
  assert.equal(call.response.status, 201, JSON.stringify(call.json));
  assert.equal(call.json.status, 'pending_approval');
  const returnId = call.json.id as string;

  // The maker cannot put returned stock or a credit note into the books alone.
  call = await api('/pieces', ownerToken);
  const heldPiece = (call.json as Array<{ barcode: string; status: string }>).
    find((piece) => piece.barcode === barcode);
  assert.equal(heldPiece?.status, 'dispatched');

  call = await api(`/approvals/customer_return/${returnId}/approve`, accountsToken, 'POST',
    { note: 'Original invoice and physical roll checked' });
  assert.equal(call.response.status, 200, JSON.stringify(call.json));

  // The supplied `rate: 1` above is intentionally ignored. The note must use
  // the exact taxed value recorded on the original invoice (10 × ₹150).
  call = await api('/gst-notes?limit=100', ownerToken);
  const note = (call.json.rows as Array<any>).find(row => row.reason === 'Customer returned the complete roll');
  assert.ok(note, 'an approved customer return must create a GST credit note');
  assert.equal(number(note.taxable_value), 1500);
  assert.equal(note.status, 'approved');

  call = await api('/reports/gstr3b-outward', ownerToken);
  const withReturn = (call.json as Array<any>).find(row => row.return_period === '08-2026');
  assert.equal(number(withReturn.taxable_value), number(beforeReturn.taxable_value) - number(note.taxable_value));
  assert.equal(number(withReturn.cgst_amount), number(beforeReturn.cgst_amount) - number(note.cgst_amount));
  assert.equal(number(withReturn.sgst_amount), number(beforeReturn.sgst_amount) - number(note.sgst_amount));
  assert.equal(number(withReturn.igst_amount), number(beforeReturn.igst_amount) - number(note.igst_amount));
  assert.equal(number(withReturn.credit_note_count), number(beforeReturn.credit_note_count) + 1);

  call = await api('/reports/gstr1-cdnr', ownerToken);
  assert.ok((call.json as Array<any>).some(row => row.note_no === note.note_no),
    'the credit note must be visible in the dedicated GSTR-1 note report');

  call = await api('/pieces', ownerToken);
  const returnedPiece = (call.json as Array<{ barcode: string; status: string; current_qty: string }>).
    find((piece) => piece.barcode === barcode);
  assert.equal(returnedPiece?.status, 'received_finish');
  assert.equal(Number(returnedPiece?.current_qty), 10);

  call = await api(`/documents/customer_return/${returnId}/cancel`, accountsToken, 'POST',
    { reason: 'Customer kept goods after all' });
  assert.equal(call.response.status, 200, JSON.stringify(call.json));

  call = await api('/gst-notes?limit=100', ownerToken);
  const cancelledNote = (call.json.rows as Array<any>).find(row => row.id === note.id);
  assert.equal(cancelledNote?.status, 'cancelled', 'the return cancellation must also cancel its GST note');

  call = await api('/reports/gstr3b-outward', ownerToken);
  const afterCancellation = (call.json as Array<any>).find(row => row.return_period === '08-2026');
  for (const key of ['taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'invoice_count', 'credit_note_count']) {
    assert.equal(number(afterCancellation[key]), number(beforeReturn[key]), `GSTR-3B ${key} must be restored`);
  }
  call = await api('/reports/gstr1-cdnr', ownerToken);
  assert.ok(!(call.json as Array<any>).some(row => row.note_no === note.note_no),
    'a cancelled note must not remain in the GSTR-1 note report');

  call = await api('/pieces', ownerToken);
  const restoredPiece = (call.json as Array<{ barcode: string; status: string; current_qty: string }>).
    find((piece) => piece.barcode === barcode);
  assert.equal(restoredPiece?.status, 'dispatched');
  assert.equal(Number(restoredPiece?.current_qty), 0);
});
