/**
 * Reports as a mill actually reads them: a period, a search, a stable order,
 * a footer that totals the whole report, and a file that can leave the screen.
 *
 * Every report used to be `select * from <view> limit 500` — no date range, no
 * ordering (so offset paging repeated and skipped rows), and no total. These
 * tests exist so it cannot quietly go back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const WEAVER = '33333333-0000-0000-0000-000000000105';
const PROCESS = '33333333-0000-0000-0000-000000000202';
const CUSTOMER = '33333333-0000-0000-0000-000000000629';
const QUALITY_GALAXY = '44444444-0000-0000-0000-000000000001';

const stamp = Date.now();
let token = '';

async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    return { status: res.status, type, text: await res.text(), body: null as any };
  }
  return { status: res.status, type, text: '', body: await res.json() };
}

test('sign in', async () => {
  const r = await api('/api/auth/login', {
    method: 'POST', body: { email: 'owner@neelkamal.test', password: 'changeme' }
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  token = r.body.token;
});

/**
 * One complete trade, so this file asserts on rows it created rather than on
 * whatever an earlier test file happened to leave behind. A run starts from a
 * rebuilt database; a report test that needs data has to make it.
 */
test('a trade to report on: inward, dye, dispatch, invoice, receipt', async () => {
  const barcodes = [`RP${stamp}A`, `RP${stamp}B`];

  const inward = await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: WEAVER, entryDate: '2026-08-21',
      challanNo: `RPCH-${stamp}`, challanDate: '2026-08-21', lotNo: `RP-${stamp}`,
      lines: barcodes.map(b => ({
        qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode: b, lotNo: `RP-${stamp}`,
        receivedQty: 100, checkedQty: 100, rate: 30.5
      }))
    }
  });
  assert.equal(inward.status, 201, JSON.stringify(inward.body));

  const issue = await api('/api/dyeing-issues', {
    method: 'POST',
    body: {
      processHouseId: PROCESS, entryDate: '2026-08-22',
      challanNo: `RPPC-${stamp}`, challanDate: '2026-08-22',
      lotNo: `RP-${stamp}`, jobRate: 18, barcodes
    }
  });
  assert.equal(issue.status, 201, JSON.stringify(issue.body));

  const receipt = await api('/api/dyeing-receipts', {
    method: 'POST',
    body: {
      processHouseId: PROCESS, entryDate: '2026-09-05',
      challanNo: `RPPR-${stamp}`, challanDate: '2026-09-05',
      lines: barcodes.map(b => ({ barcode: b, receivedQty: 100, finishGrade: 'A', jobRate: 18 }))
    }
  });
  assert.equal(receipt.status, 201, JSON.stringify(receipt.body));

  const dispatch = await api('/api/dispatches', {
    method: 'POST',
    body: {
      partyId: CUSTOMER, challanNo: `RPDC-${stamp}`, challanDate: '2026-09-10',
      lines: barcodes.map(b => ({ barcode: b, rate: 72 }))
    }
  });
  assert.equal(dispatch.status, 201, JSON.stringify(dispatch.body));

  const invoice = await api('/api/sales-invoices', {
    method: 'POST',
    body: { dispatchId: dispatch.body.id, invoiceDate: '2026-09-10', distanceKm: 40 }
  });
  assert.equal(invoice.status, 201, JSON.stringify(invoice.body));

  const money = await api('/api/payments', {
    method: 'POST',
    body: {
      kind: 'receipt', partyId: CUSTOMER, paymentDate: '2026-09-12', mode: 'cash',
      amount: 5000, narration: `report fixture ${stamp}`
    }
  });
  assert.equal(money.status, 201, JSON.stringify(money.body));
});

// ------------------------------------------------------------------ period --

test('a period report answers for the period asked for', async () => {
  const all = await api('/api/reports/barcode-history?limit=5000');
  assert.equal(all.status, 200);
  assert.ok(all.body.length > 0, 'the seed should have moved at least one piece');

  // A window that closed before this database existed holds nothing.
  const ancient = await api('/api/reports/barcode-history?from=2001-01-01&to=2001-12-31');
  assert.equal(ancient.status, 200);
  assert.deepEqual(ancient.body, [], 'a report scoped to 2001 returned rows from another year');

  const wide = await api('/api/reports/barcode-history?from=2000-01-01&to=2999-12-31&limit=5000');
  assert.equal(wide.body.length, all.body.length);
});

test('a position report refuses a date range instead of ignoring one', async () => {
  const r = await api('/api/reports/stock-summary?from=2026-04-01&to=2026-06-30');
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /no date range|position as on/i);
});

test('the catalogue says which reports take a period, so a screen can ask', async () => {
  const r = await api('/api/report-catalogue');
  assert.equal(r.status, 200);
  const by = new Map<string, any>(r.body.map((x: any) => [x.name, x]));

  assert.equal(by.get('cash-book').hasPeriod, true);
  assert.equal(by.get('sales-register').hasPeriod, true);
  assert.equal(by.get('stock-summary').hasPeriod, false);
  assert.equal(by.get('trial-balance').hasPeriod, false);
  assert.ok(by.get('cash-book').totals.includes('inflow'));
});

// ------------------------------------------------------------------ totals --

test('the footer totals the whole report, not the page on screen', async () => {
  const all = await api('/api/reports/party-balance?limit=5000');
  assert.ok(all.body.length > 1, 'need more than one ledger to tell page from report');

  const page = await api('/api/reports/party-balance?limit=1');
  assert.equal(page.body.length, 1);

  const summary = await api('/api/reports/party-balance/summary?limit=1');
  assert.equal(summary.status, 200);
  assert.equal(summary.body.total, all.body.length,
    'the summary counted the page it was handed rather than the report');

  const expected = all.body.reduce((n: number, r: any) => n + Number(r.balance), 0);
  assert.ok(Math.abs(summary.body.totals.balance - expected) < 0.005,
    `footer said ${summary.body.totals.balance}, the rows add to ${expected}`);
});

test('a search narrows the rows and the footer together', async () => {
  const one = await api('/api/reports/party-balance?limit=5000&q=Neelkamal');
  const summary = await api('/api/reports/party-balance/summary?q=Neelkamal');
  assert.equal(summary.body.total, one.body.length,
    'the footer counted a different set of rows than the search returned');
  for (const row of one.body) {
    assert.match(`${row.name} ${row.code}`, /Neelkamal/i);
  }
});

test('a total is only offered where adding the column up means something', async () => {
  const r = await api('/api/report-catalogue');
  const by = new Map<string, any>(r.body.map((x: any) => [x.name, x]));

  // Summing a percentage across process houses produces a number, not a fact.
  assert.ok(!by.get('shrinkage').totals.includes('shrinkage_pct'));
  assert.ok(by.get('shrinkage').totals.includes('issued_qty'));
  // A running balance is already cumulative; adding the column doubles it.
  assert.ok(!by.get('party-statement').totals.includes('running_balance'));
});

// ------------------------------------------------------------------ paging --

test('paging is stable: a second page is not the first page again', async () => {
  const first = await api('/api/reports/party-balance?limit=2&offset=0');
  const second = await api('/api/reports/party-balance?limit=2&offset=2');
  assert.equal(first.body.length, 2);
  if (second.body.length === 0) return;

  const seen = new Set(first.body.map((r: any) => `${r.code}`));
  for (const row of second.body) {
    assert.ok(!seen.has(row.code),
      `ledger ${row.code} was returned on both pages — the report has no ORDER BY`);
  }
});

// -------------------------------------------------------------- registers --

test('the sales register lists a bill the day it was raised', async () => {
  const invoices = await api('/api/reports/sales-register?limit=50');
  assert.equal(invoices.status, 200, JSON.stringify(invoices.body));
  if (invoices.body.length === 0) return;

  const row = invoices.body[0];
  for (const key of ['invoice_no', 'invoice_date', 'party', 'taxable_value',
                     'tax_amount', 'invoice_total']) {
    assert.ok(key in row, `the sales register is missing ${key}`);
  }
  // The register must add up the same way the invoice does.
  const parts = Number(row.taxable_value) + Number(row.tax_amount) + Number(row.round_off);
  assert.ok(Math.abs(parts - Number(row.invoice_total)) < 0.005,
    `register row totals ${parts} against an invoice of ${row.invoice_total}`);
});

test('the day book shows both legs of an entry and balances over a period', async () => {
  const r = await api('/api/reports/day-book/summary');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.total > 0, 'nothing has been posted, so nothing can be verified');
  assert.ok(Math.abs(r.body.totals.debit - r.body.totals.credit) < 0.005,
    `the day book is out of balance by ${r.body.totals.debit - r.body.totals.credit}`);
});

test('the grouped trial balance agrees with the ledger-wise one', async () => {
  const flat = await api('/api/reports/trial-balance/summary');
  const grouped = await api('/api/reports/trial-balance-grouped/summary');
  assert.equal(grouped.status, 200, JSON.stringify(grouped.body));
  assert.ok(Math.abs(flat.body.totals.total_debit - grouped.body.totals.total_debit) < 0.005,
    'grouping the trial balance changed its debits');
  assert.ok(Math.abs(flat.body.totals.total_credit - grouped.body.totals.total_credit) < 0.005,
    'grouping the trial balance changed its credits');
});

// ---------------------------------------------------------------- a ledger --

test('a ledger for a period opens with a balance and closes on the arithmetic', async () => {
  // Give the weaver a movement this year so the ledger has something to say.
  const r = await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: WEAVER, entryDate: '2026-09-15',
      challanNo: `LG-${stamp}`, challanDate: '2026-09-15', lotNo: `LG-${stamp}`,
      lines: [{ qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode: `LG${stamp}`,
                lotNo: `LG-${stamp}`, receivedQty: 100, checkedQty: 100, rate: 20 }]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  const led = await api(`/api/ledger?ledgerId=${WEAVER}&from=2026-04-01&to=2027-03-31`);
  assert.equal(led.status, 200, JSON.stringify(led.body));
  assert.equal(led.body.rows[0].seq, 0, 'the first row of a ledger is its opening balance');
  assert.equal(led.body.rows[0].voucher_type, 'opening');

  const { opening, closing, totals } = led.body;
  assert.ok(Math.abs((opening + totals.debit - totals.credit) - closing) < 0.005,
    `opening ${opening} + debits ${totals.debit} - credits ${totals.credit} != closing ${closing}`);

  // The 100 x 20 inward above credits the weaver 2,000 inside this window.
  assert.ok(totals.credit >= 2000, `the inward did not reach the ledger: ${totals.credit}`);
});

test('a period ledger carries the earlier balance forward rather than starting at zero', async () => {
  const whole = await api(`/api/ledger?ledgerId=${WEAVER}&from=2026-04-01&to=2027-03-31`);
  const later = await api(`/api/ledger?ledgerId=${WEAVER}&from=2026-09-16&to=2027-03-31`);
  assert.equal(later.status, 200, JSON.stringify(later.body));

  assert.notEqual(later.body.opening, 0,
    'a window opened after the postings began still reported a zero opening');
  assert.ok(Math.abs(later.body.closing - whole.body.closing) < 0.005,
    'the same closing balance must arrive by either route');
});

test('a ledger will not run backwards, and an unknown ledger is not invented', async () => {
  const backwards = await api(`/api/ledger?ledgerId=${WEAVER}&from=2026-09-30&to=2026-09-01`);
  assert.equal(backwards.status, 400);

  const missing = await api(
    '/api/ledger?ledgerId=33333333-0000-0000-0000-999999999999&from=2026-04-01&to=2027-03-31');
  assert.equal(missing.status, 404);
});

// -------------------------------------------------------------- delivery --

test('a report leaves the screen as a CSV of the columns asked for', async () => {
  const r = await api('/api/reports/party-balance?format=csv&columns=code,name,balance');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/csv/);
  const [header] = r.text.replace(/^﻿/, '').split('\r\n');
  assert.equal(header, 'code,name,balance');
});

test('a CSV export carries the whole report, not the first page', async () => {
  const page = await api('/api/reports/party-balance?limit=1');
  const csv = await api('/api/reports/party-balance?format=csv&limit=1&columns=code');
  const dataRows = csv.text.replace(/^﻿/, '').trim().split('\r\n').length - 1;
  assert.equal(page.body.length, 1);
  assert.ok(dataRows > 1, `the export honoured limit=1 and wrote ${dataRows} row`);
});

test('a report prints as a PDF headed with the mill and the period', async () => {
  const r = await api('/api/reports/cash-book?format=pdf&from=2026-04-01&to=2027-03-31');
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/pdf/);
  assert.ok(r.text.startsWith('%PDF-1.'), 'not a PDF');
  assert.ok(r.text.trimEnd().endsWith('%%EOF'), 'the PDF has no trailer');
  assert.match(r.text, /Neelkamal/, 'the page is not headed with the mill');
  assert.match(r.text, /Cash Book/);
  assert.match(r.text, /2026-04-01 to 2027-03-31/);
  assert.match(r.text, /TOTAL/, 'a printed report with no total line');
});

test('a ledger prints too, showing its opening and closing on the page', async () => {
  const r = await api(`/api/ledger?ledgerId=${WEAVER}&from=2026-04-01&to=2027-03-31&format=pdf`);
  assert.equal(r.status, 200);
  assert.ok(r.text.startsWith('%PDF-1.'));
  assert.match(r.text, /Opening/);
  assert.match(r.text, /Closing/);
});

test('an unknown report is a 404, not an empty answer that looks like good news', async () => {
  const r = await api('/api/reports/profit-per-employee');
  assert.equal(r.status, 404);
});
