import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTallyXml } from '../src/mill-readiness.ts';
import { renderInvoiceBundlePdf, renderPartyStatementPdf } from '../src/pdf.ts';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const WEAVER = '33333333-0000-0000-0000-000000000105';
const PROCESS = '33333333-0000-0000-0000-000000000202';
const CUSTOMER = '33333333-0000-0000-0000-000000000701';
const QUALITY = '44444444-0000-0000-0000-000000000001';
const stamp = Date.now();
const barcode = `MILL${stamp}`;
const tokens: Record<string, string> = {};
let receiptLineId = '';
let invoiceId = '';
let invoiceTotal = 0;
let paymentId = '';
let processBillId = '';

async function api(path: string, options: { method?: string; body?: unknown; as?: string } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json',
      authorization: `Bearer ${tokens[options.as ?? 'owner'] ?? ''}` },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, text };
}

test('Tally XML escapes masters and keeps every voucher balanced by sign', () => {
  const out = buildTallyXml('A & B Mills', [{
    id: '11111111-1111-1111-1111-111111111111', voucherNo: 'JV/1',
    voucherType: 'journal', voucherDate: '2026-10-01', narration: 'Shade <claim>',
    lines: [{ ledger: 'Quality Deductions', debit: 125, credit: 0 },
      { ledger: 'Customer & Co', debit: 0, credit: 125 }]
  }], [{ name: 'Customer & Co', parent: 'Sundry Debtors', billWise: true }]);
  assert.match(out, /<SVCURRENTCOMPANY>A &amp; B Mills<\/SVCURRENTCOMPANY>/);
  assert.match(out, /<NARRATION>Shade &lt;claim&gt;<\/NARRATION>/);
  assert.match(out, /<AMOUNT>-125\.00<\/AMOUNT>/);
  assert.match(out, /<AMOUNT>125\.00<\/AMOUNT>/);
  assert.match(out, /<LEDGER NAME="Customer &amp; Co" ACTION="Create">/);
  assert.match(out, /<PARENT>Sundry Debtors<\/PARENT>/);
});

test('invoice bundle PDF is structurally complete and contains a packing page', () => {
  const pdf = renderInvoiceBundlePdf({
    invoice_no: 'INV/1', invoice_date: '2026-10-01', status: 'approved', mill_name: 'A Mill',
    mill_gstin: '27AAAAA0000A1Z5', mill_address: 'Bhiwandi', party_name: 'Buyer',
    party_gstin: null, party_address: 'Surat', place_of_supply: '24', supply_type: 'inter_state',
    irn: null, challan_no: 'DC/1', challan_date: '2026-10-01', lr_no: 'LR1', lr_date: '2026-10-01',
    vehicle_no: 'MH04AB1234', transporter: 'Fast Roadways', taxable_value: 1000, cgst_amount: 0,
    sgst_amount: 0, igst_amount: 50, round_off: 0, invoice_total: 1050,
    amount_in_words: 'One Thousand Fifty Rupees Only', lines: [{ sno: 1, description: 'Fabric',
      hsn_code: '551311', barcode: 'THAAN1', grade_code: 'A', qty: 10, uom: 'MTR', rate: 100,
      taxable_value: 1000, gst_rate: 5, cgst_amount: 0, sgst_amount: 0, igst_amount: 50,
      line_total: 1050, current_weight_kg: 1.5 }]
  });
  assert.match(pdf.subarray(0, 8).toString(), /^%PDF-1\./);
  assert.match(pdf.toString(), /PACKING LIST/);
  assert.match(pdf.toString(), /%%EOF/);
});

test('outstanding statement PDF carries balances and overdue age', () => {
  const pdf = renderPartyStatementPdf({
    mill_name: 'A Mill', mill_gstin: '27AAAAA0000A1Z5', mill_address: 'Bhiwandi',
    party_name: 'Buyer', party_gstin: null, party_address: 'Surat', as_of: '2026-10-31',
    total_outstanding: 500, total_overdue: 500,
    lines: [{ invoice_no: 'INV/1', invoice_date: '2026-09-01', due_date: '2026-10-01',
      invoice_total: 1000, received_or_credited: 500, outstanding: 500, overdue_days: 30 }]
  });
  assert.match(pdf.subarray(0, 8).toString(), /^%PDF-1\./);
  assert.match(pdf.toString(), /OUTSTANDING STATEMENT/);
  assert.match(pdf.toString(), /INV\/1/);
});

test('sign in mill-floor, accounts and owner roles', async () => {
  for (const role of ['store', 'accounts', 'owner']) {
    const response = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${role}@neelkamal.test`, password: 'changeme' })
    });
    const body = await response.json() as { token: string };
    assert.equal(response.status, 200, JSON.stringify(body));
    tokens[role] = body.token;
  }
});

test('one thaan carries metres and kilograms through inward, process and receipt', async () => {
  let result = await api('/api/grey-inwards', { method: 'POST', as: 'store', body: {
    partyId: WEAVER, entryDate: '2026-10-01', challanNo: `DUAL-${stamp}`,
    challanDate: '2026-10-01', lotNo: `DUAL-${stamp}`,
    lines: [{ qualityId: QUALITY, gradeCode: 'LUMP', barcode, lotNo: `DUAL-${stamp}`,
      receivedQty: 100, checkedQty: 100, rate: 30, rateUom: 'KGS',
      grossWeightKg: 15.5, tareWeightKg: 0.5, netWeightKg: 15 }]
  }});
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(Number(result.body.value), 450, 'a kg-priced inward must capitalise kg × rate, not metres × rate');
  const inwardPiece = await api(`/api/pieces?barcode=${barcode}`, { as: 'store' });
  assert.equal(Number(inwardPiece.body[0].cost), 450);

  result = await api('/api/dyeing-issues', { method: 'POST', as: 'store', body: {
    processHouseId: PROCESS, entryDate: '2026-10-02', challanNo: `DUALI-${stamp}`,
    challanDate: '2026-10-02', lotNo: `DUAL-${stamp}`, jobRate: 18, barcodes: [barcode]
  }});
  assert.equal(result.status, 201, JSON.stringify(result.body));

  result = await api('/api/dyeing-receipts', { method: 'POST', as: 'store', body: {
    processHouseId: PROCESS, entryDate: '2026-10-05', challanNo: `DUALR-${stamp}`,
    challanDate: '2026-10-05', lines: [{ barcode, receivedQty: 95,
      receivedWeightKg: 14, finishGrade: 'A', jobRate: 18 }]
  }});
  assert.equal(result.status, 201, JSON.stringify(result.body));

  const piece = await api(`/api/pieces?barcode=${barcode}`, { as: 'store' });
  assert.equal(piece.status, 200);
  assert.equal(Number(piece.body[0].current_qty), 95);
  assert.equal(Number(piece.body[0].current_weight_kg), 14);
  assert.equal(Number(piece.body[0].glm), 147.368);
  assert.ok(Number(piece.body[0].gsm) > 100 && Number(piece.body[0].gsm) < 101);

  const history = await api(`/api/pieces/${barcode}/history`, { as: 'store' });
  assert.deepEqual(history.body.map((row: any) => Number(row.weight_after_kg)), [15, 15, 14]);
});

test('one consolidated process bill reconciles to the actual returned piece, never FIFO', async () => {
  const available = await api(`/api/process-house-bills/available-receipts?processHouseId=${PROCESS}`, { as: 'accounts' });
  assert.equal(available.status, 200, JSON.stringify(available.body));
  const line = available.body.find((row: any) => row.barcode === barcode);
  assert.ok(line, 'the actual receipt line must be offered for reconciliation');
  receiptLineId = line.receipt_line_id;
  assert.equal(Number(line.unbilled_metres), 95);
  assert.equal(Number(line.unbilled_amount), 1710);

  const bill = await api('/api/process-house-bills', { method: 'POST', as: 'accounts', body: {
    processHouseId: PROCESS, supplierBillNo: `PHB-${stamp}`, billDate: '2026-10-06',
    billedMetres: 95, billedAmount: 1710,
    allocations: [{ receiptLineId, allocatedMetres: 95, allocatedAmount: 1710 }]
  }});
  assert.equal(bill.status, 201, JSON.stringify(bill.body));
  assert.equal(Number(bill.body.metre_difference), 0);
  assert.equal(Number(bill.body.amount_difference), 0);
  processBillId = bill.body.bill_id;

  const over = await api('/api/process-house-bills', { method: 'POST', as: 'accounts', body: {
    processHouseId: PROCESS, supplierBillNo: `PHB-OVER-${stamp}`, billDate: '2026-10-06',
    billedMetres: 1, billedAmount: 18,
    allocations: [{ receiptLineId, allocatedMetres: 1, allocatedAmount: 18 }]
  }});
  assert.equal(over.status, 400);
  assert.match(over.body.error, /exceed the received metres/i);
});

test('a cancelled process-house bill releases its exact receipt allocation and keeps the audit', async () => {
  const cancelled = await api(`/api/process-house-bills/${processBillId}/cancel`, {
    method: 'POST', as: 'accounts', body: { reason: 'supplier issued a corrected bill' }
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.status, 'cancelled');

  const available = await api(`/api/process-house-bills/available-receipts?processHouseId=${PROCESS}`, { as: 'accounts' });
  const line = available.body.find((row: any) => row.receipt_line_id === receiptLineId);
  assert.equal(Number(line?.unbilled_metres), 95);

  const bills = await api('/api/process-house-bills', { as: 'accounts' });
  const audit = bills.body.find((row: any) => row.bill_id === processBillId);
  assert.equal(audit.status, 'cancelled');
  assert.equal(audit.cancellation_reason, 'supplier issued a corrected bill');

  const repeated = await api(`/api/process-house-bills/${processBillId}/cancel`, {
    method: 'POST', as: 'accounts', body: { reason: 'duplicate attempt' }
  });
  assert.equal(repeated.status, 400);
});

test('dispatch and invoice the dual-unit piece', async () => {
  const dispatch = await api('/api/dispatches', { method: 'POST', body: {
    partyId: CUSTOMER, challanNo: `DUALDC-${stamp}`, challanDate: '2026-10-07',
    lines: [{ barcode, rate: 70 }]
  }});
  assert.equal(dispatch.status, 201, JSON.stringify(dispatch.body));
  const invoice = await api('/api/sales-invoices', { method: 'POST', body: {
    dispatchId: dispatch.body.id, invoiceDate: '2026-10-07'
  }});
  assert.equal(invoice.status, 201, JSON.stringify(invoice.body));
  invoiceId = invoice.body.id;
  invoiceTotal = Number(invoice.body.invoiceTotal);
});

test('typed kapat settles the bill and posts quality deduction separately', async () => {
  const before = await api('/api/reports/party-balance');
  const beforeQuality = Number(before.body.find((row: any) => row.code === '984')?.balance ?? 0);
  const receipt = await api('/api/payments', { method: 'POST', as: 'accounts', body: {
    kind: 'receipt', partyId: CUSTOMER, paymentDate: '2026-10-08', mode: 'cash',
    amount: invoiceTotal - 100,
    allocations: [{ salesInvoiceId: invoiceId, amount: invoiceTotal }],
    deductions: [{ salesInvoiceId: invoiceId, kind: 'quality_discount', amount: 100,
      reason: 'shade variation accepted in settlement', taxTreatment: 'credit_note_required' }]
  }});
  assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
  assert.equal(receipt.body.deductions, 100);
  assert.equal(receipt.body.taxDocumentsRequired, 1);
  paymentId = receipt.body.id;

  const outstanding = await api('/api/reports/outstanding-sales');
  assert.equal(Number(outstanding.body.find((row: any) => row.invoice_id === invoiceId)?.outstanding), 0);
  const after = await api('/api/reports/party-balance');
  assert.equal(Number(after.body.find((row: any) => row.code === '984')?.balance), beforeQuality + 100);
});

test('cancelling that receipt restores the bill and reverses kapat without deleting the audit', async () => {
  const cancelled = await api(`/api/payments/${paymentId}/cancel`, { method: 'POST', body: {
    reason: 'settlement test reversal'
  }});
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const outstanding = await api('/api/reports/outstanding-sales');
  assert.equal(Number(outstanding.body.find((row: any) => row.invoice_id === invoiceId)?.outstanding), invoiceTotal);
});

test('Tally download contains posted vouchers and valid import envelope', async () => {
  const response = await fetch(`${BASE}/api/exports/tally.xml?from=2026-10-01&to=2026-10-31`, {
    headers: { authorization: `Bearer ${tokens.owner}` }
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.match(response.headers.get('content-type') ?? '', /xml/);
  assert.match(body, /<TALLYREQUEST>Import Data<\/TALLYREQUEST>/);
  assert.match(body, /<LEDGER NAME=/);
  assert.match(body, /DUALDC|Receipt|Sales/);
});

test('the combined invoice and packing PDF downloads as an actual PDF', async () => {
  const response = await fetch(`${BASE}/api/sales-invoices/${invoiceId}/pdf`, {
    headers: { authorization: `Bearer ${tokens.owner}` }
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/pdf/);
  assert.match(bytes.subarray(0, 8).toString(), /^%PDF-1\./);
  assert.match(bytes.toString(), /PACKING LIST/);
});

test('approved invoices queue idempotently for WhatsApp without pretending credentials exist', async () => {
  const ledgers = await api('/api/ledgers?limit=500');
  const customer = ledgers.body.find((row: any) => row.id === CUSTOMER);
  assert.ok(customer);
  const updated = await api('/api/ledgers', { method: 'POST', body: {
    ...customer, mobile_e164: '+919999999999'
  }});
  assert.equal(updated.status, 201, JSON.stringify(updated.body));

  const first = await api(`/api/notifications/invoices/${invoiceId}`, {
    method: 'POST', as: 'accounts', body: {}
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const again = await api(`/api/notifications/invoices/${invoiceId}`, {
    method: 'POST', as: 'accounts', body: {}
  });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.id, first.body.id, 'the outbox key must make retries idempotent');

  const outbox = await api('/api/notifications', { as: 'accounts' });
  assert.equal(outbox.status, 200);
  assert.equal(outbox.body.rows.filter((row: any) => row.id === first.body.id).length, 1);
});

test('accounts can download and queue one idempotent payment reminder statement', async () => {
  const response = await fetch(`${BASE}/api/ledgers/${CUSTOMER}/outstanding-statement.pdf?asOf=2026-10-31`, {
    headers: { authorization: `Bearer ${tokens.accounts}` }
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.match(bytes.toString(), /OUTSTANDING STATEMENT/);
  assert.match(bytes.toString(), /NKT\/26-27/);

  const first = await api(`/api/notifications/reminders/${CUSTOMER}`, {
    method: 'POST', as: 'accounts', body: { asOf: '2026-10-31' }
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const again = await api(`/api/notifications/reminders/${CUSTOMER}`, {
    method: 'POST', as: 'accounts', body: { asOf: '2026-10-31' }
  });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.id, first.body.id);

  const cancelled = await api(`/api/notifications/${first.body.id}/cancel`, {
    method: 'POST', as: 'accounts', body: {}
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.state, 'cancelled');
});
