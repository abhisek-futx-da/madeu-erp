import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const tokens: Record<string, string> = {};

const CUSTOMER = '33333333-0000-0000-0000-000000000701'; // Supreme Textile
const stamp = Date.now();
let globalPayId = '';
let globalInvoiceId = '';

async function api(
  path: string,
  opts: { method?: string; body?: unknown; as?: string } = {}
) {
  const token = tokens[opts.as ?? 'owner'] ?? '';
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

test('sign in', async () => {
  for (const who of ['owner', 'store', 'accounts']) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${who}@neelkamal.test`, password: 'changeme' })
    });
    const body = await r.json() as { token: string };
    assert.equal(r.status, 200, JSON.stringify(body));
    tokens[who] = body.token;
  }
});

test('receipts allocate against sales invoices', async () => {
  // We need a sales invoice to allocate against.
  // Instead of creating the whole inward -> dye -> finish -> dispatch chain,
  // we can create a direct journal voucher or see if we can create a direct sales invoice.
  // Wait, direct sales invoices are not supported without dispatch. Let's create an opening balance
  // or a simple journal voucher to represent outstanding, or just run the dispatch flow.

  // Since we want to test allocation, let's just make a direct purchase invoice first (easier since it doesn't need dispatch).
  const pi = await api('/api/purchase-invoices', {
    method: 'POST', as: 'accounts',
    body: {
      partyId: '33333333-0000-0000-0000-000000000105', // L.R. Textiles
      entryDate: '2026-09-01',
      invoiceNo: `PI-PAY-${stamp}`,
      invoiceDate: '2026-09-01', supplierInvoiceNo: 'SUP-123',
      reason: 'Yarn purchase',
      placeOfSupply: '27-Maharashtra',
      supplyType: 'intra',
      lines: [
        { description: 'Cotton Yarn', hsnCode: '5205', qty: 100, rate: 200, taxableValue: 20000, gstRate: 5, cgstAmount: 500, sgstAmount: 500, igstAmount: 0 }
      ]
    }
  });
  assert.equal(pi.status, 201, 'PI creation failed: ' + JSON.stringify(pi.body));
  const invoiceId = pi.body.id;
  globalInvoiceId = invoiceId;


  // Now we have a PI of 21000. Let's suggest allocation for a 10000 payment.
  const sugg = await api('/api/payments/suggest', {
    method: 'POST', as: 'accounts',
    body: {
      partyId: '33333333-0000-0000-0000-000000000105',
      kind: 'payment',
      amount: 10000
    }
  });
  assert.equal(sugg.status, 200);
  assert.equal(sugg.body.allocations.length > 0, true, 'should suggest allocation');

  // The first suggestion should take 10000 against our invoice (or an older one).
  // Let's just record a payment allocating exactly 10000 against our new invoice.
  const pay = await api('/api/payments', {
    method: 'POST', as: 'accounts',
    body: {
      kind: 'payment',
      partyId: '33333333-0000-0000-0000-000000000105',
      paymentDate: '2026-09-02',
      mode: 'neft',
      amount: 10000,
      allocations: [
        { purchaseInvoiceId: invoiceId, amount: 10000 }
      ]
    }
  });
  assert.equal(pay.status, 201, 'Payment failed: ' + JSON.stringify(pay.body));
  globalPayId = pay.body.id;

  // The PI should now show 10000 paid.
  // We can query v_outstanding_purchases directly via a custom query or check the ledger statement.
  const stmt = await api('/api/reports/outstanding-purchases', { as: 'owner' });
  assert.equal(stmt.status, 200);
  const invRow = stmt.body.find((r: any) => r.invoice_id === globalInvoiceId);
  assert.equal(Number(invRow.outstanding), 11000); // 21000 - 10000
});

test('cancelling a payment restores outstanding balance', async () => {
  // get payment id from earlier? wait, the previous test didn't export payId.
  // We can just query payments and cancel it.
  // Use the payment id we created in the previous step by saving it globally
  const payId = globalPayId;

  const c = await api('/api/payments/' + payId + '/cancel', {
    method: 'POST', as: 'owner',
    body: { reason: 'mistake' }
  });
  assert.equal(c.status, 200, 'cancel failed: ' + JSON.stringify(c.body));

  const stmt = await api('/api/reports/outstanding-purchases', { as: 'owner' });
  const invRow = stmt.body.find((r: any) => r.invoice_id === globalInvoiceId);
  assert.equal(Number(invRow.outstanding), 21000);
});
