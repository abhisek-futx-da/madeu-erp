/**
 * Inward tax, credit/debit notes, configurable policy and the accounting
 * reports a CA asks for. Runs against a live database and API.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';

const WEAVER = '33333333-0000-0000-0000-000000000105';   // registered, Maharashtra
const PROCESS = '33333333-0000-0000-0000-000000000202';
const BROKER = '33333333-0000-0000-0000-000000000801';   // unregistered -> RCM
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

// ------------------------------------------------------------- inward tax --

test('an intra-state purchase claims CGST and SGST as input credit', async () => {
  const r = await api('/api/purchase-invoices', {
    method: 'POST',
    body: {
      partyId: WEAVER, supplierInvoiceNo: `SUP-${stamp}-1`, invoiceDate: '2026-09-01',
      kind: 'grey',
      lines: [{ hsnCode: '551311', description: 'Galaxy grey', qty: 1000, rate: 30.5, gstRate: 5 }]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.supplyType, 'intra_state');
  assert.equal(r.body.taxableValue, 30500);
  assert.equal(r.body.cgst, 762.5);
  assert.equal(r.body.sgst, 762.5);
  assert.equal(r.body.igst, 0);
  assert.equal(r.body.itcClaimed, 1525);
});

test('the same supplier invoice cannot be booked twice', async () => {
  const body = {
    partyId: WEAVER, supplierInvoiceNo: `SUP-${stamp}-1`, invoiceDate: '2026-09-01',
    kind: 'grey' as const,
    lines: [{ hsnCode: '551311', description: 'dup', qty: 1, rate: 1, gstRate: 5 }]
  };
  const r = await api('/api/purchase-invoices', { method: 'POST', body });
  assert.equal(r.status, 409);
});

test('an unregistered supplier triggers reverse charge, netting to zero', async () => {
  const r = await api('/api/purchase-invoices', {
    method: 'POST',
    body: {
      partyId: BROKER, supplierInvoiceNo: `BRK-${stamp}`, invoiceDate: '2026-09-02',
      kind: 'jobwork',
      lines: [{ hsnCode: '998821', description: 'Brokerage', qty: 1, rate: 5000, gstRate: 5 }]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.isRcm, true);
  // The supplier bills without tax...
  assert.equal(r.body.cgst, 0);
  assert.equal(r.body.sgst, 0);
  assert.equal(r.body.invoiceTotal, 5000);
  // ...but we self-assess it and claim the matching credit.
  assert.equal(r.body.itcClaimed, 250);
});

test('a store user cannot book a purchase invoice', async () => {
  const r = await api('/api/purchase-invoices', {
    method: 'POST', token: store,
    body: {
      partyId: WEAVER, supplierInvoiceNo: `NOPE-${stamp}`, invoiceDate: '2026-09-01',
      lines: [{ hsnCode: '551311', description: 'x', qty: 1, rate: 1, gstRate: 5 }]
    }
  });
  assert.equal(r.status, 403);
});

test('input credit is reported and nets against output in the liability view', async () => {
  const [itc, liability] = await Promise.all([
    api('/api/reports/itc-summary'),
    api('/api/reports/gst-liability')
  ]);
  assert.equal(itc.status, 200);
  assert.ok(itc.body.length > 0, 'expected input credit rows');

  assert.equal(liability.status, 200);
  const sept = liability.body.find((p: any) => p.return_period === '09-2026');
  assert.ok(sept, 'expected a September liability row');
  assert.equal(
    Math.round((Number(sept.output_cgst) - Number(sept.credit_cgst)) * 100) / 100,
    Math.round(Number(sept.net_cgst) * 100) / 100
  );
});

// --------------------------------------------------------- credit notes --

let invoiceId = '';
let invoiceTaxable = 0;

test('set up an invoice to credit against', async () => {
  const barcodes = [`ACC${stamp}0`, `ACC${stamp}1`];
  await api('/api/grey-inwards', {
    method: 'POST', token: store,
    body: {
      partyId: WEAVER, entryDate: '2026-08-21', challanNo: `ACCCH-${stamp}`,
      challanDate: '2026-08-21', lotNo: 'ACC',
      lines: barcodes.map(b => ({
        qualityId: GALAXY, gradeCode: 'LUMP', barcode: b, lotNo: 'ACC',
        receivedQty: 100, checkedQty: 100, rate: 30.5
      }))
    }
  });
  await api('/api/dyeing-issues', {
    method: 'POST', token: store,
    body: {
      processHouseId: PROCESS, entryDate: '2026-08-22', challanNo: `ACCPC-${stamp}`,
      challanDate: '2026-08-22', lotNo: 'ACC', jobRate: 18, barcodes
    }
  });
  await api('/api/dyeing-receipts', {
    method: 'POST', token: store,
    body: {
      processHouseId: PROCESS, entryDate: '2026-09-05', challanNo: `ACCPR-${stamp}`,
      challanDate: '2026-09-05',
      lines: barcodes.map(b => ({ barcode: b, receivedQty: 95, finishGrade: 'A', jobRate: 18 }))
    }
  });
  const d = await api('/api/dispatches', {
    method: 'POST',
    body: {
      partyId: MADURAI, challanNo: `ACCDC-${stamp}`, challanDate: '2026-09-10',
      lines: barcodes.map(b => ({ barcode: b, rate: 80 }))
    }
  });
  assert.equal(d.status, 201);

  const inv = await api('/api/sales-invoices', {
    method: 'POST', body: { dispatchId: d.body.id, invoiceDate: '2026-09-10' }
  });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  invoiceId = inv.body.id;
  invoiceTaxable = inv.body.taxableValue;
  assert.equal(invoiceTaxable, 15200); // 2 x 95 x 80
});

test('a credit note reverses the sale and its tax', async () => {
  const r = await api('/api/gst-notes', {
    method: 'POST',
    body: {
      kind: 'credit', againstInvoiceId: invoiceId, noteDate: '2026-09-15',
      reason: 'Shade variation returned', taxableValue: 1520
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.taxableValue, 1520);
  assert.equal(r.body.igst, 76);      // inter-state, 5%
  assert.equal(r.body.cgst, 0);
  assert.equal(r.body.noteTotal, 1596);
  assert.match(r.body.noteNo, /^CN\//);
});

test('credit notes cannot exceed the invoice they credit', async () => {
  const r = await api('/api/gst-notes', {
    method: 'POST',
    body: {
      kind: 'credit', againstInvoiceId: invoiceId, noteDate: '2026-09-16',
      reason: 'too much', taxableValue: invoiceTaxable
    }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /cannot exceed the invoice/i);
});

test('a debit note adds to the receivable', async () => {
  const r = await api('/api/gst-notes', {
    method: 'POST',
    body: {
      kind: 'debit', againstInvoiceId: invoiceId, noteDate: '2026-09-16',
      reason: 'Freight recovered', taxableValue: 500
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.igst, 25);
  assert.match(r.body.noteNo, /^DN\//);
});

// ------------------------------------------------------------- reporting --

test('the trial balance sums to zero', async () => {
  const r = await api('/api/reports/trial-balance');
  assert.equal(r.status, 200);
  assert.ok(r.body.length > 0);
  const total = r.body.reduce((n: number, x: any) => n + Number(x.balance), 0);
  assert.ok(Math.abs(total) < 0.01, `trial balance is off by ${total}`);

  const debits = r.body.reduce((n: number, x: any) => n + Number(x.total_debit), 0);
  const credits = r.body.reduce((n: number, x: any) => n + Number(x.total_credit), 0);
  assert.ok(Math.abs(debits - credits) < 0.01, `debits ${debits} vs credits ${credits}`);
});

test('receivable ageing buckets every open invoice', async () => {
  const r = await api('/api/reports/receivable-ageing');
  assert.equal(r.status, 200);
  assert.ok(r.body.length > 0);
  const buckets = new Set(r.body.map((x: any) => x.bucket));
  for (const b of buckets) {
    assert.ok(['0-30', '31-60', '61-90', '91-180', '180+'].includes(b as string), `odd bucket ${b}`);
  }
  for (const row of r.body) {
    assert.ok(Number(row.age_days) >= Number(row.overdue_days), 'overdue cannot exceed age');
  }
});

test('a party statement runs a correct running balance', async () => {
  const r = await api('/api/reports/party-statement');
  assert.equal(r.status, 200);
  const rows = r.body.filter((x: any) => x.code === '701');
  assert.ok(rows.length > 0, 'expected movement on the customer account');

  let running = 0;
  for (const row of rows) {
    running += Number(row.debit) - Number(row.credit);
    assert.ok(
      Math.abs(running - Number(row.running_balance)) < 0.01,
      `running balance drifted: expected ${running}, got ${row.running_balance}`
    );
  }
});

test('quality margin nets grey and jobwork cost off revenue', async () => {
  const r = await api('/api/reports/quality-margin');
  assert.equal(r.status, 200);
  const row = r.body.find((x: any) => x.quality === 'Galaxy');
  assert.ok(row, 'expected a Galaxy row');
  assert.equal(
    Math.round((Number(row.revenue) - Number(row.grey_cost) - Number(row.jobwork_cost)) * 100) / 100,
    Math.round(Number(row.margin) * 100) / 100
  );
});

test('the process-house scorecard reports shrinkage and turnaround', async () => {
  const r = await api('/api/reports/process-house-scorecard');
  assert.equal(r.status, 200);
  const row = r.body.find((x: any) => x.process_house === 'Prayag Texprint Llp');
  assert.ok(row);
  assert.ok(Number(row.received_qty) <= Number(row.issued_qty));
  assert.ok(Number(row.avg_turnaround_days) > 0, 'goods take time to come back');
});

test('the weaver scorecard reports a fill rate', async () => {
  const r = await api('/api/reports/weaver-scorecard');
  assert.equal(r.status, 200);
  for (const row of r.body) {
    if (row.fill_rate_pct != null) {
      assert.ok(Number(row.fill_rate_pct) >= 0, 'fill rate cannot be negative');
    }
  }
});
