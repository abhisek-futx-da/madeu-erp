/**
 * Payments, inventory valuation and cancellation — the three gaps that made
 * this not an ERP. Runs against a live database and API.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const WEAVER = '33333333-0000-0000-0000-000000000105';
const PROCESS = '33333333-0000-0000-0000-000000000202';
const CUSTOMER = '33333333-0000-0000-0000-000000000701';
const GALAXY = '44444444-0000-0000-0000-000000000001';

let owner = '';
let store = '';
const stamp = Date.now();

async function api(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.token ?? owner}`
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const signIn = async (email: string) => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'changeme' })
  });
  return ((await r.json()) as { token: string }).token;
};

const ledgerBalance = async (code: string) => {
  const r = await api('/api/reports/trial-balance');
  return Number(r.body.find((x: any) => x.code === code)?.balance ?? 0);
};

const trialBalanceDrift = async () => {
  const r = await api('/api/reports/trial-balance');
  return r.body.reduce((n: number, x: any) => n + Number(x.balance), 0);
};

/** Walks pieces to dispatched and returns the dispatch and invoice. */
async function sellSomething(tag: string, count: number, rate: number) {
  const barcodes = Array.from({ length: count }, (_, i) => `MON${stamp}${tag}${i}`);
  await api('/api/grey-inwards', {
    method: 'POST', token: store,
    body: {
      partyId: WEAVER, entryDate: '2026-08-21', challanNo: `MONCH-${stamp}-${tag}`,
      challanDate: '2026-08-21', lotNo: `M${tag}`,
      lines: barcodes.map(b => ({
        qualityId: GALAXY, gradeCode: 'LUMP', barcode: b, lotNo: `M${tag}`,
        receivedQty: 100, checkedQty: 100, rate: 30
      }))
    }
  });
  await api('/api/dyeing-issues', {
    method: 'POST', token: store,
    body: {
      processHouseId: PROCESS, entryDate: '2026-08-22', challanNo: `MONPC-${stamp}-${tag}`,
      challanDate: '2026-08-22', lotNo: `M${tag}`, jobRate: 18, barcodes
    }
  });
  await api('/api/dyeing-receipts', {
    method: 'POST', token: store,
    body: {
      processHouseId: PROCESS, entryDate: '2026-09-05', challanNo: `MONPR-${stamp}-${tag}`,
      challanDate: '2026-09-05',
      lines: barcodes.map(b => ({ barcode: b, receivedQty: 95, finishGrade: 'A', jobRate: 18 }))
    }
  });
  const d = await api('/api/dispatches', {
    method: 'POST',
    body: {
      partyId: CUSTOMER, challanNo: `MONDC-${stamp}-${tag}`, challanDate: '2026-09-10',
      lines: barcodes.map(b => ({ barcode: b, rate }))
    }
  });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const inv = await api('/api/sales-invoices', {
    method: 'POST', body: { dispatchId: d.body.id, invoiceDate: '2026-09-10' }
  });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  return { barcodes, dispatchId: d.body.id as string, invoice: inv.body };
}

test('sign in', async () => {
  owner = await signIn('owner@neelkamal.test');
  store = await signIn('store@neelkamal.test');
  assert.ok(owner && store);
});

// ------------------------------------------------------------- valuation --

test('buying grey creates an asset, not an immediate expense', async () => {
  const stockBefore = await ledgerBalance('960');
  const barcodes = [`VAL${stamp}0`, `VAL${stamp}1`];

  const r = await api('/api/grey-inwards', {
    method: 'POST', token: store,
    body: {
      partyId: WEAVER, entryDate: '2026-08-21', challanNo: `VALCH-${stamp}`,
      challanDate: '2026-08-21', lotNo: 'VAL',
      lines: barcodes.map(b => ({
        qualityId: GALAXY, gradeCode: 'LUMP', barcode: b, lotNo: 'VAL',
        receivedQty: 100, checkedQty: 100, rate: 30
      }))
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  // Grey stock is a debit balance and it grew by exactly what we bought.
  const stockAfter = await ledgerBalance('960');
  assert.equal(Math.round((stockAfter - stockBefore) * 100) / 100, 6000);

  const valuation = await api('/api/reports/stock-valuation');
  assert.equal(valuation.status, 200);
  const grey = valuation.body.find((v: any) => v.status === 'grey_in_stock');
  assert.ok(grey, 'grey stock should be valued');
  assert.ok(Number(grey.total_cost) > 0, 'stock cannot be worth nothing');
});

test('jobwork moves cost from grey stock into finish stock', async () => {
  const barcodes = [`JOB${stamp}0`];
  await api('/api/grey-inwards', {
    method: 'POST', token: store,
    body: {
      partyId: WEAVER, entryDate: '2026-08-21', challanNo: `JOBCH-${stamp}`,
      challanDate: '2026-08-21', lotNo: 'JOB',
      lines: barcodes.map(b => ({
        qualityId: GALAXY, gradeCode: 'LUMP', barcode: b, lotNo: 'JOB',
        receivedQty: 100, checkedQty: 100, rate: 30
      }))
    }
  });
  await api('/api/dyeing-issues', {
    method: 'POST', token: store,
    body: {
      processHouseId: PROCESS, entryDate: '2026-08-22', challanNo: `JOBPC-${stamp}`,
      challanDate: '2026-08-22', lotNo: 'JOB', jobRate: 18, barcodes
    }
  });

  const finishBefore = await ledgerBalance('961');
  const r = await api('/api/dyeing-receipts', {
    method: 'POST', token: store,
    body: {
      processHouseId: PROCESS, entryDate: '2026-09-05', challanNo: `JOBPR-${stamp}`,
      challanDate: '2026-09-05',
      lines: [{ barcode: barcodes[0]!, receivedQty: 95, finishGrade: 'A', jobRate: 18 }]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  // 3000 grey in + 95 x 18 = 1710 jobwork -> 4710 sitting in finish stock.
  const finishAfter = await ledgerBalance('961');
  assert.equal(Math.round((finishAfter - finishBefore) * 100) / 100, 4710);
});

test('shrinkage beyond the configured policy is refused', async () => {
  const barcode = `SHR${stamp}`;
  await api('/api/grey-inwards', {
    method: 'POST', token: store,
    body: {
      partyId: WEAVER, entryDate: '2026-08-21', challanNo: `SHRCH-${stamp}`,
      challanDate: '2026-08-21', lotNo: 'SHR',
      lines: [{
        qualityId: GALAXY, gradeCode: 'LUMP', barcode, lotNo: 'SHR',
        receivedQty: 100, checkedQty: 100, rate: 30
      }]
    }
  });
  await api('/api/dyeing-issues', {
    method: 'POST', token: store,
    body: {
      processHouseId: PROCESS, entryDate: '2026-08-22', challanNo: `SHRPC-${stamp}`,
      challanDate: '2026-08-22', lotNo: 'SHR', jobRate: 18, barcodes: [barcode]
    }
  });

  // Prayag's policy caps loss at 9%; 20% must be refused rather than displayed.
  const bad = await api('/api/dyeing-receipts', {
    method: 'POST', token: store,
    body: {
      processHouseId: PROCESS, entryDate: '2026-09-05', challanNo: `SHRPR-${stamp}`,
      challanDate: '2026-09-05',
      lines: [{ barcode, receivedQty: 80, finishGrade: 'A', jobRate: 18 }]
    }
  });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.match(bad.body.error, /shrinkage outside the agreed policy/i);

  // Within policy it goes through.
  const ok = await api('/api/dyeing-receipts', {
    method: 'POST', token: store,
    body: {
      processHouseId: PROCESS, entryDate: '2026-09-05', challanNo: `SHRPR2-${stamp}`,
      challanDate: '2026-09-05',
      lines: [{ barcode, receivedQty: 95, finishGrade: 'A', jobRate: 18 }]
    }
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('selling releases the accumulated cost to cost of goods sold', async () => {
  const cogsBefore = await ledgerBalance('962');
  await sellSomething('A', 2, 80);
  const cogsAfter = await ledgerBalance('962');

  // 2 pieces: (100 x 30) grey + (95 x 18) jobwork each = 4710 x 2.
  assert.equal(Math.round((cogsAfter - cogsBefore) * 100) / 100, 9420);
});

// -------------------------------------------------------------- payments --

test('a receipt settles an invoice and reduces what the customer owes', async () => {
  const sale = await sellSomething('B', 1, 100);
  const invoiceTotal = Number(sale.invoice.invoiceTotal);

  const before = await api('/api/reports/outstanding-sales');
  const bill = before.body.find((o: any) => o.invoice_no === sale.invoice.invoiceNo);
  assert.ok(bill, 'the invoice should be outstanding');
  assert.equal(Math.round(Number(bill.outstanding) * 100) / 100, invoiceTotal);

  const r = await api('/api/payments', {
    method: 'POST',
    body: {
      kind: 'receipt', partyId: CUSTOMER, paymentDate: '2026-09-20',
      mode: 'neft', amount: invoiceTotal, instrumentNo: `UTR-${stamp}`,
      narration: 'full settlement',
      allocations: [{ salesInvoiceId: sale.invoice.id, amount: invoiceTotal }]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.voucherNo, /^RV\//);
  assert.equal(r.body.allocated, invoiceTotal);
  assert.equal(r.body.onAccount, 0);

  const after = await api('/api/reports/outstanding-sales');
  const settled = after.body.find((o: any) => o.invoice_no === sale.invoice.invoiceNo);
  assert.equal(Math.round(Number(settled.outstanding) * 100) / 100, 0, 'the bill must be settled');
});

test('a receipt moves the bank and the customer, and the books still balance', async () => {
  const bankBefore = await ledgerBalance('971');
  const custBefore = await ledgerBalance('701');

  const r = await api('/api/payments', {
    method: 'POST',
    body: {
      kind: 'receipt', partyId: CUSTOMER, paymentDate: '2026-09-21',
      mode: 'neft', amount: 5000, instrumentNo: `ONACC-${stamp}`
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.onAccount, 5000, 'unallocated money sits on account');

  assert.equal(Math.round((await ledgerBalance('971') - bankBefore) * 100) / 100, 5000);
  assert.equal(Math.round((await ledgerBalance('701') - custBefore) * 100) / 100, -5000);
  assert.ok(Math.abs(await trialBalanceDrift()) < 0.01);
});

test('oldest-first allocation is suggested rather than typed by hand', async () => {
  await sellSomething('C', 1, 60);
  const r = await api('/api/payments/suggest', {
    method: 'POST', body: { partyId: CUSTOMER, kind: 'receipt', amount: 1000 }
  });
  assert.equal(r.status, 200);
  const total = r.body.allocations.reduce((n: number, a: any) => n + a.amount, 0);
  assert.ok(Math.abs(total + r.body.onAccount - 1000) < 0.01, 'the suggestion must account for every rupee');
});

test('a payment cannot allocate more than it is worth', async () => {
  const sale = await sellSomething('D', 1, 70);
  const r = await api('/api/payments', {
    method: 'POST',
    body: {
      kind: 'receipt', partyId: CUSTOMER, paymentDate: '2026-09-22',
      mode: 'cash', amount: 100,
      allocations: [{ salesInvoiceId: sale.invoice.id, amount: 99999 }]
    }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /exceed/i);
});

test('a receipt cannot be allocated against a purchase invoice', async () => {
  const pur = await api('/api/purchase-invoices', {
    method: 'POST',
    body: {
      partyId: WEAVER, supplierInvoiceNo: `MIX-${stamp}`, invoiceDate: '2026-09-01',
      kind: 'grey',
      lines: [{ hsnCode: '551311', description: 'grey', qty: 10, rate: 30, gstRate: 5 }]
    }
  });
  assert.equal(pur.status, 201);

  const r = await api('/api/payments', {
    method: 'POST',
    body: {
      kind: 'receipt', partyId: CUSTOMER, paymentDate: '2026-09-22',
      mode: 'cash', amount: 100,
      allocations: [{ purchaseInvoiceId: pur.body.id, amount: 100 }]
    }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /cannot be allocated against that invoice type/i);
});

test('paying a supplier reduces what we owe them', async () => {
  const pur = await api('/api/purchase-invoices', {
    method: 'POST',
    body: {
      partyId: WEAVER, supplierInvoiceNo: `PAY-${stamp}`, invoiceDate: '2026-09-02',
      kind: 'grey',
      lines: [{ hsnCode: '551311', description: 'grey', qty: 100, rate: 30, gstRate: 5 }]
    }
  });
  assert.equal(pur.status, 201);
  const owed = Number(pur.body.invoiceTotal);

  const r = await api('/api/payments', {
    method: 'POST',
    body: {
      kind: 'payment', partyId: WEAVER, paymentDate: '2026-09-25',
      mode: 'rtgs', amount: owed, instrumentNo: `OUT-${stamp}`,
      allocations: [{ purchaseInvoiceId: pur.body.id, amount: owed }]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.voucherNo, /^PV\//);

  const out = await api('/api/reports/outstanding-purchases');
  const bill = out.body.find((o: any) => o.supplier_invoice_no === `PAY-${stamp}`);
  assert.equal(Math.round(Number(bill.outstanding) * 100) / 100, 0);
});

test('a cancelled receipt is reversed, not deleted', async () => {
  const r = await api('/api/payments', {
    method: 'POST',
    body: {
      kind: 'receipt', partyId: CUSTOMER, paymentDate: '2026-09-26',
      mode: 'cash', amount: 1234
    }
  });
  assert.equal(r.status, 201);
  const bankBefore = await ledgerBalance('970');

  const c = await api(`/api/payments/${r.body.id}/cancel`, {
    method: 'POST', body: { reason: 'entered against the wrong party' }
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));

  assert.equal(Math.round((await ledgerBalance('970') - bankBefore) * 100) / 100, -1234);
  const list = await api('/api/payments');
  const still = list.body.rows.find((p: any) => p.id === r.body.id);
  assert.ok(still, 'the cancelled receipt stays visible');
  assert.equal(still.status, 'cancelled');
  assert.ok(Math.abs(await trialBalanceDrift()) < 0.01);
});

// ---------------------------------------------------------- credit limit --

test('a dispatch beyond the credit limit is refused before the truck loads', async () => {
  // The customer's limit is 500000; push well past it in one go.
  const barcodes = Array.from({ length: 3 }, (_, i) => `CRD${stamp}${i}`);
  await api('/api/grey-inwards', {
    method: 'POST', token: store,
    body: {
      partyId: WEAVER, entryDate: '2026-08-21', challanNo: `CRDCH-${stamp}`,
      challanDate: '2026-08-21', lotNo: 'CRD',
      lines: barcodes.map(b => ({
        qualityId: GALAXY, gradeCode: 'LUMP', barcode: b, lotNo: 'CRD',
        receivedQty: 100, checkedQty: 100, rate: 30
      }))
    }
  });
  await api('/api/dyeing-issues', {
    method: 'POST', token: store,
    body: {
      processHouseId: PROCESS, entryDate: '2026-08-22', challanNo: `CRDPC-${stamp}`,
      challanDate: '2026-08-22', lotNo: 'CRD', jobRate: 18, barcodes
    }
  });
  await api('/api/dyeing-receipts', {
    method: 'POST', token: store,
    body: {
      processHouseId: PROCESS, entryDate: '2026-09-05', challanNo: `CRDPR-${stamp}`,
      challanDate: '2026-09-05',
      lines: barcodes.map(b => ({ barcode: b, receivedQty: 95, finishGrade: 'A', jobRate: 18 }))
    }
  });

  const r = await api('/api/dispatches', {
    method: 'POST',
    body: {
      partyId: CUSTOMER, challanNo: `CRDDC-${stamp}`, challanDate: '2026-09-10',
      lines: barcodes.map(b => ({ barcode: b, rate: 9000 }))
    }
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /credit limit exceeded/i);
});

// ---------------------------------------------------------- cancellation --

test('an invoiced dispatch cannot be cancelled out from under its invoice', async () => {
  const sale = await sellSomething('E', 1, 50);
  const r = await api(`/api/documents/dispatch/${sale.dispatchId}/cancel`, {
    method: 'POST', body: { reason: 'wrong customer' }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /cancel the tax invoice first/i);
});

test('cancelling an invoice then its dispatch reverses both and returns the stock', async () => {
  // Measured from before the sale, so a full cancellation must return to zero.
  const cogsBefore = await ledgerBalance('962');
  const sale = await sellSomething('F', 1, 55);

  const inv = await api(`/api/documents/sales_invoice/${sale.invoice.id}/cancel`, {
    method: 'POST', body: { reason: 'billed in error' }
  });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  assert.ok(inv.body.reversedVouchers > 0, 'the sale must be reversed');

  const disp = await api(`/api/documents/dispatch/${sale.dispatchId}/cancel`, {
    method: 'POST', body: { reason: 'goods came back' }
  });
  assert.equal(disp.status, 200, JSON.stringify(disp.body));
  assert.equal(disp.body.revertedPieces, 1);

  // This dispatch also did the packing (it shipped straight from finish), so
  // cancelling it undoes both hops and the piece lands back at received_finish.
  const piece = await api(`/api/pieces?barcode=${sale.barcodes[0]}`);
  assert.equal(piece.body[0].status, 'received_finish');
  assert.equal(Math.round((await ledgerBalance('962') - cogsBefore) * 100) / 100, 0);

  const history = await api(`/api/pieces/${sale.barcodes[0]}/history`);
  assert.equal(history.body.at(-1).event, 'adjust', 'the walk-back is itself in the log');
  assert.ok(Math.abs(await trialBalanceDrift()) < 0.01);
});

test('cancelling twice is refused', async () => {
  const sale = await sellSomething('G', 1, 45);
  const first = await api(`/api/documents/sales_invoice/${sale.invoice.id}/cancel`, {
    method: 'POST', body: { reason: 'once' }
  });
  assert.equal(first.status, 200);
  const second = await api(`/api/documents/sales_invoice/${sale.invoice.id}/cancel`, {
    method: 'POST', body: { reason: 'twice' }
  });
  assert.equal(second.status, 400);
  assert.match(second.body.error, /already cancelled/i);
});

// ----------------------------------------------------------- integrity --

test('the spine agrees with its own movement log', async () => {
  const r = await api('/api/reports/piece-drift');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, [], 'no piece may disagree with its last movement');
});

test('everything above leaves the books balanced', async () => {
  assert.ok(Math.abs(await trialBalanceDrift()) < 0.01);
});
