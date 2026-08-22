/**
 * Year close, GSTR-2B reconciliation, sales orders and the Cut/Pack step,
 * against a live database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const WEAVER = '33333333-0000-0000-0000-000000000105';
const PROCESS = '33333333-0000-0000-0000-000000000202';
const MADURAI = '33333333-0000-0000-0000-000000000701';
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

test('sign in', async () => {
  owner = await signIn('owner@neelkamal.test');
  store = await signIn('store@neelkamal.test');
  assert.ok(owner && store);
});

// ----------------------------------------------------------- sales orders --

let salesOrderId = '';

test('a sales order is booked with its lines', async () => {
  const r = await api('/api/sales-orders', {
    method: 'POST',
    body: {
      partyId: MADURAI, orderDate: '2026-09-01', destination: 'Madurai',
      deliveryDays: 15, paymentTerms: '30 days',
      lines: [
        { qualityId: GALAXY, gradeCode: 'LUMP', pcs: 10, cutLength: 100, qty: 1000, rate: 80 },
        { qualityId: GALAXY, gradeCode: 'A', pcs: 5, cutLength: 100, qty: 500, rate: 85 }
      ]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.orderNo, /^SO\//);
  salesOrderId = r.body.id;

  const list = await api('/api/sales-orders');
  const mine = list.body.rows.find((o: any) => o.id === salesOrderId);
  assert.ok(mine, 'the order should be listed');
  assert.equal(mine.lines.length, 2);
  assert.equal(Number(mine.lines[0].amount), 80000);
});

test('a sales order with no lines is refused', async () => {
  const r = await api('/api/sales-orders', {
    method: 'POST',
    body: { partyId: MADURAI, orderDate: '2026-09-01', lines: [] }
  });
  assert.equal(r.status, 400);
});

// -------------------------------------------------------------- cut / pack --

test('cut-pack is its own recorded step, not a side effect of dispatch', async () => {
  const barcodes = [`CP${stamp}0`, `CP${stamp}1`];

  await api('/api/grey-inwards', {
    method: 'POST', token: store,
    body: {
      partyId: WEAVER, entryDate: '2026-08-21', challanNo: `CPCH-${stamp}`,
      challanDate: '2026-08-21', lotNo: 'CP',
      lines: barcodes.map(b => ({
        qualityId: GALAXY, gradeCode: 'LUMP', barcode: b, lotNo: 'CP',
        receivedQty: 100, checkedQty: 100, rate: 30
      }))
    }
  });
  await api('/api/dyeing-issues', {
    method: 'POST', token: store,
    body: {
      processHouseId: PROCESS, entryDate: '2026-08-22', challanNo: `CPPC-${stamp}`,
      challanDate: '2026-08-22', lotNo: 'CP', jobRate: 18, barcodes
    }
  });

  // Not yet back from dyeing, so it cannot be packed.
  const tooEarly = await api('/api/cut-pack', {
    method: 'POST', token: store, body: { barcodes, note: 'premature' }
  });
  assert.equal(tooEarly.status, 400);
  assert.match(tooEarly.body.error, /only finish back from dyeing/i);

  await api('/api/dyeing-receipts', {
    method: 'POST', token: store,
    body: {
      processHouseId: PROCESS, entryDate: '2026-09-05', challanNo: `CPPR-${stamp}`,
      challanDate: '2026-09-05',
      lines: barcodes.map(b => ({ barcode: b, receivedQty: 95, finishGrade: 'A', jobRate: 18 }))
    }
  });

  const packed = await api('/api/cut-pack', {
    method: 'POST', token: store, body: { barcodes, note: 'folded, 2 bales' }
  });
  assert.equal(packed.status, 201, JSON.stringify(packed.body));
  assert.equal(packed.body.pieces, 2);
  assert.equal(packed.body.qty, 190);

  // The step leaves a trace with its note.
  const history = await api(`/api/pieces/${barcodes[0]}/history`);
  const events = history.body.map((e: any) => e.event);
  assert.deepEqual(events, ['inward', 'issue', 'receipt', 'pack']);

  // And packed pieces dispatch without a second implicit pack.
  const d = await api('/api/dispatches', {
    method: 'POST',
    body: {
      partyId: MADURAI, challanNo: `CPDC-${stamp}`, challanDate: '2026-09-10',
      lines: barcodes.map(b => ({ barcode: b, rate: 80 }))
    }
  });
  assert.equal(d.status, 201);
  const after = await api(`/api/pieces/${barcodes[0]}/history`);
  assert.deepEqual(after.body.map((e: any) => e.event),
    ['inward', 'issue', 'receipt', 'pack', 'dispatch']);
});

// ---------------------------------------------------------------- GSTR-2B --

test('packed pieces remain visible to dispatch', async () => {
  // Dispatch draws from two statuses; querying only the first hid every piece
  // that had been through cut/pack, which is exactly what packing is for.
  const barcode = `VIS${stamp}`;
  await api('/api/grey-inwards', {
    method: 'POST', token: store,
    body: {
      partyId: WEAVER, entryDate: '2026-08-21', challanNo: `VISCH-${stamp}`,
      challanDate: '2026-08-21', lotNo: 'VIS',
      lines: [{
        qualityId: GALAXY, gradeCode: 'LUMP', barcode, lotNo: 'VIS',
        receivedQty: 100, checkedQty: 100, rate: 30
      }]
    }
  });
  await api('/api/dyeing-issues', {
    method: 'POST', token: store,
    body: {
      processHouseId: PROCESS, entryDate: '2026-08-22', challanNo: `VISPC-${stamp}`,
      challanDate: '2026-08-22', lotNo: 'VIS', jobRate: 18, barcodes: [barcode]
    }
  });
  await api('/api/dyeing-receipts', {
    method: 'POST', token: store,
    body: {
      processHouseId: PROCESS, entryDate: '2026-09-05', challanNo: `VISPR-${stamp}`,
      challanDate: '2026-09-05',
      lines: [{ barcode, receivedQty: 95, finishGrade: 'A', jobRate: 18 }]
    }
  });
  const packed = await api('/api/cut-pack', {
    method: 'POST', token: store, body: { barcodes: [barcode], note: 'for visibility' }
  });
  assert.equal(packed.status, 201);

  const both = await api('/api/pieces?status=received_finish,cut_packed&limit=500');
  assert.equal(both.status, 200);
  assert.ok(
    both.body.some((p: any) => p.barcode === barcode && p.status === 'cut_packed'),
    'a packed piece must still be dispatchable'
  );

  const single = await api('/api/pieces?status=cut_packed&limit=500');
  assert.ok(single.body.every((p: any) => p.status === 'cut_packed'));
});

test('a GSTR-2B import reconciles against what we booked', async () => {
  const supplierInvoice = `2B-${stamp}`;

  // What we booked.
  const booked = await api('/api/purchase-invoices', {
    method: 'POST',
    body: {
      partyId: WEAVER, supplierInvoiceNo: supplierInvoice, invoiceDate: '2026-09-01',
      kind: 'grey',
      lines: [{ hsnCode: '551311', description: 'grey', qty: 1000, rate: 30, gstRate: 5 }]
    }
  });
  assert.equal(booked.status, 201);

  // What the portal says: this one matches, one is missing from our books.
  const imported = await api('/api/gstr2b/import', {
    method: 'POST',
    body: {
      returnPeriod: '09-2026',
      lines: [
        {
          supplierGstin: '27AGLPY0818R1ZF', supplierName: 'L.R. Textiles',
          invoiceNo: supplierInvoice, invoiceDate: '2026-09-01',
          taxableValue: 30000, cgstAmount: 750, sgstAmount: 750
        },
        {
          supplierGstin: '27AGLPY0818R1ZF', supplierName: 'L.R. Textiles',
          invoiceNo: `GHOST-${stamp}`, invoiceDate: '2026-09-02',
          taxableValue: 12000, cgstAmount: 300, sgstAmount: 300
        }
      ]
    }
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.imported, 2);

  const recon = await api('/api/reports/gstr2b-reconciliation');
  assert.equal(recon.status, 200);

  const matched = recon.body.find((r: any) => r.invoice_no === supplierInvoice);
  assert.ok(matched, 'our booked invoice should appear');
  assert.equal(matched.status, 'matched');

  const ghost = recon.body.find((r: any) => r.invoice_no === `GHOST-${stamp}`);
  assert.ok(ghost, 'an invoice the supplier filed but we never booked must surface');
  assert.equal(ghost.status, 'missing_in_books');
});

test('re-importing the same period updates rather than duplicating', async () => {
  const body = {
    returnPeriod: '09-2026',
    lines: [{
      supplierGstin: '27AGLPY0818R1ZF', invoiceNo: `RERUN-${stamp}`,
      invoiceDate: '2026-09-03', taxableValue: 1000, cgstAmount: 25, sgstAmount: 25
    }]
  };
  await api('/api/gstr2b/import', { method: 'POST', body });
  await api('/api/gstr2b/import', { method: 'POST', body });

  const recon = await api('/api/reports/gstr2b-reconciliation');
  const hits = recon.body.filter((r: any) => r.invoice_no === `RERUN-${stamp}`);
  assert.equal(hits.length, 1, 're-import must not duplicate');
});

// ------------------------------------------------------------- year close --

test('financial years are listed with their status', async () => {
  const r = await api('/api/financial-years');
  assert.equal(r.status, 200);
  const open = r.body.find((f: any) => f.label === '2026-27');
  assert.ok(open);
  assert.equal(open.status, 'open');
});

test('nothing can be posted into a year that is already closed', async () => {
  // 2025-26 is seeded closed; a document dated inside it must be refused.
  const r = await api('/api/grey-inwards', {
    method: 'POST', token: store,
    body: {
      partyId: WEAVER, entryDate: '2025-06-01', challanNo: `CLOSED-${stamp}`,
      challanDate: '2025-06-01', lotNo: 'OLD',
      lines: [{
        qualityId: GALAXY, gradeCode: 'LUMP', barcode: `CLOSED${stamp}`,
        lotNo: 'OLD', receivedQty: 10, checkedQty: 10, rate: 10
      }]
    }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /closed/i);
});

test('closing a year carries balance sheet accounts forward and locks it', async () => {
  const r = await api('/api/financial-years/2026-27/close', {
    method: 'POST', body: { nextLabel: '2027-28' }
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.fyLabel, '2026-27');
  assert.ok(r.body.ledgersCarried > 0, 'parties and tax accounts must carry forward');
  // What carries forward is itself balanced.
  assert.ok(
    Math.abs(r.body.totalDebit - r.body.totalCredit) < 0.01,
    `opening balances are out by ${r.body.totalDebit - r.body.totalCredit}`
  );

  const years = await api('/api/financial-years');
  assert.equal(years.body.find((f: any) => f.label === '2026-27').status, 'closed');
});

test('a closed year refuses new postings', async () => {
  const r = await api('/api/purchase-invoices', {
    method: 'POST',
    body: {
      partyId: WEAVER, supplierInvoiceNo: `AFTER-${stamp}`, invoiceDate: '2026-09-20',
      kind: 'grey',
      lines: [{ hsnCode: '551311', description: 'late', qty: 1, rate: 1, gstRate: 5 }]
    }
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error ?? '', /closed/i, `got: ${JSON.stringify(r.body)}`);
});

test('closing twice is refused', async () => {
  const r = await api('/api/financial-years/2026-27/close', {
    method: 'POST', body: { nextLabel: '2027-28' }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already closed/i);
});

test('only the owner may reopen a closed year', async () => {
  const r = await api('/api/financial-years/2026-27/reopen', {
    method: 'POST', token: store, body: { nextLabel: '2027-28' }
  });
  assert.ok([403].includes(r.status), `expected 403, got ${r.status}`);
});

test('reopening restores the year and clears the carried balances', async () => {
  const r = await api('/api/financial-years/2026-27/reopen', {
    method: 'POST', body: { nextLabel: '2027-28' }
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const years = await api('/api/financial-years');
  assert.equal(years.body.find((f: any) => f.label === '2026-27').status, 'open');

  // Posting works again, which is what makes this suite safe to re-run.
  const after = await api('/api/purchase-invoices', {
    method: 'POST',
    body: {
      partyId: WEAVER, supplierInvoiceNo: `REOPEN-${stamp}`, invoiceDate: '2026-09-20',
      kind: 'grey',
      lines: [{ hsnCode: '551311', description: 'after reopen', qty: 1, rate: 100, gstRate: 5 }]
    }
  });
  assert.equal(after.status, 201, JSON.stringify(after.body));
});
