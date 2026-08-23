/**
 * Invoicing against a live database: dispatch -> tax invoice -> posted voucher
 * -> validated IRP payload -> GSTR figures. Needs a seeded database and a
 * running API (see README).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';

const WEAVER = '33333333-0000-0000-0000-000000000105';   // L.R. Textiles, Maharashtra
const PROCESS = '33333333-0000-0000-0000-000000000202';  // Prayag Texprint, Maharashtra
const MADURAI = '33333333-0000-0000-0000-000000000701';  // Supreme Textile, Tamil Nadu (33)
const BHIWANDI = '33333333-0000-0000-0000-000000000629'; // Kanhaiya Textiles, Maharashtra (27)
const BROKER = '33333333-0000-0000-0000-000000000801';   // Venugopal Mudaliar
const GALAXY = '44444444-0000-0000-0000-000000000001';

let token = '';
let interStateInvoiceId = '';
const stamp = Date.now();

async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Walks pieces all the way to cut_packed so they can be dispatched. */
async function pieceReadyToShip(tag: string, count: number, qty: number, rate: number) {
  const barcodes = Array.from({ length: count }, (_, i) => `INV${stamp}${tag}${i}`);

  const inward = await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: WEAVER, entryDate: '2026-08-21',
      challanNo: `INVCH-${stamp}-${tag}`, challanDate: '2026-08-21', lotNo: `L${tag}`,
      lines: barcodes.map(b => ({
        qualityId: GALAXY, gradeCode: 'LUMP', barcode: b, lotNo: `L${tag}`,
        receivedQty: qty, checkedQty: qty, rate: 30.5
      }))
    }
  });
  assert.equal(inward.status, 201, JSON.stringify(inward.body));

  const issue = await api('/api/dyeing-issues', {
    method: 'POST',
    body: {
      processHouseId: PROCESS, entryDate: '2026-08-22',
      challanNo: `INVPC-${stamp}-${tag}`, challanDate: '2026-08-22',
      lotNo: `L${tag}`, jobRate: 18, barcodes
    }
  });
  assert.equal(issue.status, 201, JSON.stringify(issue.body));

  const receipt = await api('/api/dyeing-receipts', {
    method: 'POST',
    body: {
      processHouseId: PROCESS, entryDate: '2026-09-05',
      challanNo: `INVPR-${stamp}-${tag}`, challanDate: '2026-09-05',
      lines: barcodes.map(b => ({ barcode: b, receivedQty: qty, finishGrade: 'A', jobRate: 18 }))
    }
  });
  assert.equal(receipt.status, 201, JSON.stringify(receipt.body));

  return { barcodes, rate };
}

async function dispatchTo(partyId: string, barcodes: string[], rate: number, tag: string) {
  const d = await api('/api/dispatches', {
    method: 'POST',
    body: {
      partyId, challanNo: `INVDC-${stamp}-${tag}`, challanDate: '2026-09-10',
      lines: barcodes.map(b => ({ barcode: b, rate }))
    }
  });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  return d.body.id as string;
}

test('sign in', async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@neelkamal.test', password: 'changeme' })
  });
  assert.equal(r.status, 200);
  token = ((await r.json()) as { token: string }).token;
});

test('an inter-state dispatch invoices as IGST', async () => {
  const { barcodes, rate } = await pieceReadyToShip('A', 2, 112.1, 72);
  const dispatchId = await dispatchTo(MADURAI, barcodes, rate, 'A');

  const inv = await api('/api/sales-invoices', {
    method: 'POST', body: { dispatchId, invoiceDate: '2026-09-10', distanceKm: 1180 }
  });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));

  // 2 x 112.10 x 72 = 16142.40 taxable; 5% IGST = 807.12; total 16949.52 -> 16950
  assert.equal(inv.body.supplyType, 'inter_state');
  assert.equal(inv.body.placeOfSupply, '33');
  assert.equal(inv.body.taxableValue, 16142.4);
  assert.equal(inv.body.igst, 807.12);
  assert.equal(inv.body.cgst, 0);
  assert.equal(inv.body.sgst, 0);
  assert.equal(inv.body.roundOff, 0.48);
  assert.equal(inv.body.invoiceTotal, 16950);
  assert.deepEqual(inv.body.einvoiceIssues, [], 'payload should be IRP-ready');
  assert.equal(inv.body.einvoiceReady, true);
  interStateInvoiceId = inv.body.id;
});

test('an intra-state dispatch invoices as CGST + SGST', async () => {
  const { barcodes, rate } = await pieceReadyToShip('B', 2, 112.1, 72);
  const dispatchId = await dispatchTo(BHIWANDI, barcodes, rate, 'B');

  const inv = await api('/api/sales-invoices', {
    method: 'POST', body: { dispatchId, invoiceDate: '2026-09-10' }
  });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));

  assert.equal(inv.body.supplyType, 'intra_state');
  assert.equal(inv.body.placeOfSupply, '27');
  assert.equal(inv.body.taxableValue, 16142.4);
  assert.equal(inv.body.igst, 0);
  assert.equal(inv.body.cgst, 403.56);
  assert.equal(inv.body.sgst, 403.56);
  assert.equal(inv.body.cgst, inv.body.sgst);
  assert.equal(inv.body.invoiceTotal, 16950);
});

test('a dispatch cannot be invoiced twice', async () => {
  const { barcodes, rate } = await pieceReadyToShip('C', 1, 100, 60);
  const dispatchId = await dispatchTo(MADURAI, barcodes, rate, 'C');

  const first = await api('/api/sales-invoices', { method: 'POST', body: { dispatchId } });
  assert.equal(first.status, 201);

  const second = await api('/api/sales-invoices', { method: 'POST', body: { dispatchId } });
  assert.equal(second.status, 400);
  assert.match(second.body.error, /already invoiced/i);
});

test('the owner-selected invoice rounding policy changes real invoice totals', async () => {
  const saved = await api('/api/configuration/settings', {
    method: 'POST', body: { invoiceRounding: 'none', enforceCreditLimit: true }
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const purchase = await api('/api/purchase-invoices', {
    method: 'POST',
    body: {
      partyId: WEAVER, supplierInvoiceNo: `ROUND-${stamp}`, invoiceDate: '2026-09-09',
      kind: 'grey',
      lines: [{ hsnCode: '551311', description: 'rounding proof', qty: 1, rate: 1, gstRate: 5 }]
    }
  });
  assert.equal(purchase.status, 201, JSON.stringify(purchase.body));
  assert.equal(purchase.body.invoiceTotal, 1.06);

  const restored = await api('/api/configuration/settings', {
    method: 'POST', body: { invoiceRounding: 'nearest_rupee', enforceCreditLimit: true }
  });
  assert.equal(restored.status, 200);
});

test('a configured sales broker accrues in the invoice voucher and cancellation reverses it', async () => {
  const before = await api('/api/reports/party-balance');
  const beforeExpense = Number(before.body.find((row: any) => row.code === '982')?.balance ?? 0);
  const beforeBroker = Number(before.body.find((row: any) => row.code === '801')?.balance ?? 0);
  const { barcodes, rate } = await pieceReadyToShip('BR', 1, 100, 50);
  const order = await api('/api/sales-orders', {
    method: 'POST',
    body: {
      partyId: MADURAI, brokerId: BROKER, orderDate: '2026-09-01',
      lines: [{ qualityId: GALAXY, gradeCode: 'A', pcs: 1, cutLength: 100, qty: 100, rate }]
    }
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  const orders = await api('/api/sales-orders?limit=500');
  const booked = orders.body.rows.find((row: any) => row.id === order.body.id);
  assert.ok(booked?.lines[0]?.id, 'the order line must be addressable by dispatch');

  const dispatch = await api('/api/dispatches', {
    method: 'POST',
    body: {
      partyId: MADURAI, challanNo: `INVDC-${stamp}-BR`, challanDate: '2026-09-10',
      lines: [{ barcode: barcodes[0], rate, soLineId: booked.lines[0].id }]
    }
  });
  assert.equal(dispatch.status, 201, JSON.stringify(dispatch.body));

  const invoice = await api('/api/sales-invoices', {
    method: 'POST', body: { dispatchId: dispatch.body.id, invoiceDate: '2026-09-10' }
  });
  assert.equal(invoice.status, 201, JSON.stringify(invoice.body));
  assert.equal(invoice.body.taxableValue, 5000);
  assert.equal(invoice.body.brokerId, BROKER);
  assert.equal(invoice.body.brokerage, 25, '0.5% of taxable value must accrue exactly');

  const posted = await api('/api/reports/party-balance');
  assert.equal(Number(posted.body.find((row: any) => row.code === '982')?.balance), beforeExpense + 25,
    'brokerage expense must be debited');
  assert.equal(Number(posted.body.find((row: any) => row.code === '801')?.balance), beforeBroker - 25,
    'the broker must be credited');

  const cancelled = await api(`/api/documents/sales_invoice/${invoice.body.id}/cancel`, {
    method: 'POST', body: { reason: 'brokerage reversal proof' }
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

  const reversed = await api('/api/reports/party-balance');
  assert.equal(Number(reversed.body.find((row: any) => row.code === '982')?.balance), beforeExpense);
  assert.equal(Number(reversed.body.find((row: any) => row.code === '801')?.balance), beforeBroker);
});

test('the e-invoice payload is stored and matches the NIC schema', async () => {
  const list = await api('/api/sales-invoices?limit=500');
  assert.equal(list.status, 200);
  assert.ok(list.body.rows.length >= 3);

  // Specifically the invoice raised with a distance, not just any inter-state one.
  const target = list.body.rows.find((i: any) => i.id === interStateInvoiceId);
  assert.ok(target, 'the inter-state invoice should be listed');
  const doc = await api(`/api/sales-invoices/${target.id}/einvoice`);
  assert.equal(doc.status, 200);
  assert.equal(doc.body.filing_status, 'ready');
  assert.equal(doc.body.last_error, null);

  const p = doc.body.payload;
  assert.equal(p.Version, '1.1');
  assert.equal(p.TranDtls.SupTyp, 'B2B');
  assert.equal(p.DocDtls.Typ, 'INV');
  assert.match(p.DocDtls.Dt, /^\d{2}\/\d{2}\/\d{4}$/);
  assert.equal(p.BuyerDtls.Pos, '33');
  assert.equal(typeof p.SellerDtls.Pin, 'number');
  assert.ok(p.ItemList.length >= 1);
  assert.equal(p.ValDtls.TotInvVal, target.invoice_total);
  assert.equal(p.EwbDtls.Distance, 1180);
});

test('books still balance after tax postings', async () => {
  const r = await api('/api/reports/party-balance');
  const total = r.body.reduce((n: number, row: any) => n + Number(row.balance), 0);
  assert.ok(Math.abs(total) < 0.01, `books drifted by ${total}`);

  const cgst = r.body.find((x: any) => x.code === '910');
  const igst = r.body.find((x: any) => x.code === '912');
  assert.ok(cgst && Number(cgst.balance) < 0, 'output CGST should be a credit balance');
  assert.ok(igst && Number(igst.balance) < 0, 'output IGST should be a credit balance');
});

test('GSTR-1 B2B splits by rate and reconciles to the invoices', async () => {
  const r = await api('/api/reports/gstr1-b2b');
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 3);

  for (const row of r.body) {
    assert.ok(row.recipient_gstin, 'B2B rows need a counterparty GSTIN');
    const legs = Number(row.cgst_amount) + Number(row.sgst_amount) + Number(row.igst_amount);
    const expected = Math.round(Number(row.taxable_value) * Number(row.gst_rate)) / 100;
    assert.ok(Math.abs(legs - expected) < 0.02,
      `${row.invoice_no}: tax ${legs} vs expected ${expected}`);
    if (row.supply_type === 'intra_state') assert.equal(Number(row.igst_amount), 0);
    else assert.equal(Number(row.cgst_amount), 0);
  }
});

test('GSTR-3B outward totals match live invoices net of live credit/debit notes', async () => {
  const [b3, invoices, notes] = await Promise.all([
    api('/api/reports/gstr3b-outward'),
    api('/api/sales-invoices?from=2026-09-01&to=2026-09-30&limit=500'),
    api('/api/gst-notes?from=2026-09-01&to=2026-09-30&limit=500')
  ]);
  assert.equal(b3.status, 200);

  const period = b3.body.find((p: any) => p.return_period === '09-2026');
  assert.ok(period, 'expected a September 2026 period');

  // A return declares what is in the books. A cancelled invoice is out, and so
  // is one still waiting on an approver — it is on the list, because the list
  // is how you find it, but it is not yet a supply anyone has declared.
  const POSTED = new Set(['approved', 'partly_done', 'closed']);
  const live = invoices.body.rows.filter((i: any) => POSTED.has(i.status));
  const signed = (field: string) => (notes.body.rows as any[])
    .filter(n => POSTED.has(n.status))
    .reduce((n: number, note: any) => n + (note.note_kind === 'credit' ? -1 : 1) * Number(note[field]), 0);
  for (const field of ['taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount']) {
    const invoiceTotal = live.reduce((n: number, i: any) => n + Number(i[field]), 0);
    const expected = invoiceTotal + signed(field);
    assert.ok(Math.abs(Number(period[field]) - expected) < 0.01,
      `3B ${field} says ${period[field]}, expected ${expected}`);
  }
  assert.equal(Number(period.invoice_count), live.length);
});

test('HSN summary reports quantity and tax per HSN', async () => {
  const r = await api('/api/reports/gstr1-hsn');
  assert.equal(r.status, 200);
  const row = r.body.find((x: any) => x.hsn_code === '551311');
  assert.ok(row, 'expected the shirting HSN');
  assert.equal(row.uom, 'MTR');
  assert.ok(Number(row.total_qty) > 0);
});
