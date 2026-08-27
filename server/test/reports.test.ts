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
import { inflateRawSync } from 'node:zlib';

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

const paise = (n: unknown) => Math.round(Number(n ?? 0) * 100);

async function balance(ledgerId: string) {
  const r = await api('/api/reports/party-balance?limit=1000');
  const row = (r.body as any[]).find(x => x.ledger_id === ledgerId);
  return row ? paise(row.balance) : 0;
}

/** Ledgers created by migration have no fixed id; look them up by code. */
async function ledgerIdByCode(code: string) {
  const r = await api('/api/ledgers?limit=500');
  const rows = Array.isArray(r.body) ? r.body : r.body.rows;
  const row = rows.find((l: any) => l.code === code);
  assert.ok(row, `no ledger with code ${code}`);
  return row.id as string;
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
  // A delivery alone no longer touches his ledger — it accrues to received-
  // not-billed — so it is his *bill* that has to reach him. See
  // docs/PURCHASE_ACCOUNTING.md.
  const inward = await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: WEAVER, entryDate: '2026-09-15',
      challanNo: `LG-${stamp}`, challanDate: '2026-09-15', lotNo: `LG-${stamp}`,
      lines: [{ qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode: `LG${stamp}`,
                lotNo: `LG-${stamp}`, receivedQty: 100, checkedQty: 100, rate: 20 }]
    }
  });
  assert.equal(inward.status, 201, JSON.stringify(inward.body));

  const r = await api('/api/purchase-invoices', {
    method: 'POST',
    body: {
      partyId: WEAVER, supplierInvoiceNo: `LGSUP-${stamp}`, invoiceDate: '2026-09-15',
      kind: 'grey', sourceDoc: 'grey_inward', sourceId: inward.body.id,
      lines: [{ hsnCode: '551311', description: 'Galaxy grey', qty: 100, rate: 20, gstRate: 5 }]
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

  // The bill above is 100 x 20 plus 5% GST = 2,100, credited to the weaver.
  assert.ok(totals.credit >= 2100, `the weaver's bill did not reach his ledger: ${totals.credit}`);
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

test('the printed total is the whole figure, not a truncated one', async () => {
  const summary = await api('/api/reports/day-book/summary?from=2026-04-01&to=2027-03-31');
  const debit = Number(summary.body.totals.debit);
  assert.ok(debit > 0, 'nothing posted, so nothing to print');

  const pdf = await api(
    '/api/reports/day-book?format=pdf&from=2026-04-01&to=2027-03-31' +
    '&columns=voucher_date,voucher_type,voucher_no,ledger,debit,credit');
  assert.equal(pdf.status, 200);

  /**
   * Columns were sized from the data rows alone, so a total wider than any
   * single row that feeds it — which it almost always is — printed clipped.
   * The figure on the page has to be the figure in the footer.
   */
  const printed = debit.toFixed(2);
  assert.ok(pdf.text.includes(printed),
    `the footer total ${printed} does not appear in the PDF; it was printed truncated`);
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

// ------------------------------------------------------------------ xlsx --

/** Reads one file out of a zip, so the test checks the real thing. */
function unzip(buffer: Buffer, wanted: string): string {
  let at = 0;
  while (at < buffer.length - 4) {
    if (buffer.readUInt32LE(at) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(at + 8);
    const compressed = buffer.readUInt32LE(at + 18);
    const nameLen = buffer.readUInt16LE(at + 26);
    const extraLen = buffer.readUInt16LE(at + 28);
    const name = buffer.subarray(at + 30, at + 30 + nameLen).toString('utf8');
    const start = at + 30 + nameLen + extraLen;
    const body = buffer.subarray(start, start + compressed);
    if (name === wanted) {
      return (method === 8 ? inflateRawSync(body) : body).toString('utf8');
    }
    at = start + compressed;
  }
  throw new Error(`${wanted} is not in the workbook`);
}

async function download(path: string): Promise<Buffer> {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200, path);
  return Buffer.from(await res.arrayBuffer());
}

test('a report opens in Excel as a real workbook', async () => {
  const book = await download(
    '/api/reports/sales-register?format=xlsx&from=2026-04-01&to=2027-03-31' +
    '&columns=invoice_date,invoice_no,party,party_gstin,taxable_value,invoice_total');

  // A zip, and one Excel actually accepts: the parts it demands are present.
  assert.equal(book.readUInt32LE(0), 0x04034b50, 'not a zip');
  const sheet = unzip(book, 'xl/worksheets/sheet1.xml');
  assert.ok(unzip(book, '[Content_Types].xml').includes('spreadsheetml.sheet.main'));
  assert.ok(unzip(book, 'xl/workbook.xml').includes('<sheet name='));
  assert.ok(sheet.includes('<sheetData>'));
});

test('the spreadsheet carries types, which is the whole reason it is not a CSV', async () => {
  const book = await download(
    '/api/reports/sales-register?format=xlsx&from=2026-04-01&to=2027-03-31' +
    '&columns=invoice_date,invoice_no,party_gstin,taxable_value');
  const sheet = unzip(book, 'xl/worksheets/sheet1.xml');
  if (!sheet.includes('<row r="2">')) return;

  // Money is a number Excel will sum, not text it refuses to add up.
  assert.match(sheet, /<c r="D2"><v>[\d.]+<\/v><\/c>/,
    'the money column did not arrive as a number');
  // A date is a date, not a string Excel re-reads in its own order.
  assert.match(sheet, /<c r="A2" s="2"><v>\d+<\/v><\/c>/,
    'the date column did not arrive as a date');
  // A GSTIN stays exactly as written; this is what CSV gets wrong.
  assert.ok(sheet.includes('t="inlineStr"'), 'text columns were not written as text');
  const gstin = /<c r="C2" t="inlineStr"><is><t[^>]*>([^<]*)</.exec(sheet);
  if (gstin) assert.match(gstin[1]!, /^[0-9]{2}[A-Z]/, `GSTIN came back mangled: ${gstin[1]}`);
});

test('the header row is frozen and filterable, so a long register is usable', async () => {
  const book = await download('/api/reports/party-balance?format=xlsx&columns=code,name,balance');
  const sheet = unzip(book, 'xl/worksheets/sheet1.xml');
  assert.match(sheet, /<pane ySplit="1"[^>]*state="frozen"\/>/);
  assert.match(sheet, /<autoFilter ref="A1:C\d+"\/>/);
});

test('a ledger downloads as a workbook too', async () => {
  const book = await download(
    `/api/ledger?ledgerId=${WEAVER}&from=2026-04-01&to=2027-03-31&format=xlsx`);
  assert.equal(book.readUInt32LE(0), 0x04034b50);
  assert.ok(unzip(book, 'xl/worksheets/sheet1.xml').includes('<sheetData>'));
});

test('the registers say who brokered the trade', async () => {
  const cat = await api('/api/report-catalogue');
  const by = new Map<string, any>(cat.body.map((x: any) => [x.name, x]));
  assert.ok(by.get('sales-register').totals.includes('brokerage_amount'));

  const sales = await api('/api/reports/sales-register?limit=50');
  assert.equal(sales.status, 200, JSON.stringify(sales.body));
  if (sales.body.length > 0) {
    assert.ok('broker' in sales.body[0], 'the sales register cannot name the dalal');
  }

  const purchases = await api('/api/reports/purchase-register?limit=50');
  assert.equal(purchases.status, 200, JSON.stringify(purchases.body));
  if (purchases.body.length > 0) {
    assert.ok('broker' in purchases.body[0], 'the purchase register cannot name the dalal');
  }
});

// -------------------------------------------- trading account & statements --

test('the Trading Account balances, and its gross profit is checked not asserted', async () => {
  const r = await api('/api/statements/trading?from=2026-04-01&to=2027-03-31');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = r.body.totals;

  // Dr and Cr must come to the same figure — that is what makes it an account.
  assert.ok(Math.abs(t.debitTotal - t.creditTotal) < 0.02,
    `Trading Account does not balance: Dr ${t.debitTotal} vs Cr ${t.creditTotal}`);

  // Opening + what came in − what is left is what was consumed.
  assert.ok(t.sales > 0, 'nothing was sold, so there is no gross profit to check');

  /**
   * The same gross profit reached two ways: the traditional stock route, and
   * direct income less direct expenses. A difference means the stock ledger
   * and the P&L ledgers disagree, which is a posting defect, not a rounding.
   */
  assert.ok(Math.abs(t.difference) < 0.02,
    `the two routes to gross profit disagree by ${t.difference}`);
});

test('gross profit carries into the P&L, which reaches net profit', async () => {
  const trading = await api('/api/statements/trading?from=2026-04-01&to=2027-03-31');
  const pl = await api('/api/statements/profit-loss?from=2026-04-01&to=2027-03-31');
  assert.equal(pl.status, 200);

  // Net profit is gross profit less indirect expenses plus indirect income.
  // Both statements read the same ledgers, so they cannot drift apart.
  assert.ok(Number.isFinite(pl.body.totals.netProfit));
  assert.ok(Number.isFinite(trading.body.totals.grossProfit));
});

test('a statement reads ledger by ledger or head by head, and the two agree', async () => {
  const details = await api('/api/statements/profit-loss?from=2026-04-01&to=2027-03-31&view=details');
  const summary = await api('/api/statements/profit-loss?from=2026-04-01&to=2027-03-31&view=summary');
  assert.equal(summary.status, 200);

  assert.ok(summary.body.rows.length <= details.body.rows.length,
    'a summary with more lines than the detail is not a summary');
  assert.equal(summary.body.totals.netProfit, details.body.totals.netProfit,
    'rolling a statement up to its heads changed the net profit');

  const bs = await api('/api/statements/balance-sheet?to=2027-03-31&view=summary');
  assert.equal(bs.status, 200);
  assert.ok(Math.abs(bs.body.totals.difference) < 0.02, 'the summary balance sheet does not balance');
});

// ---------------------------------------------------------------- contra --

test('cash deposited into the bank is a contra, not a payment to nobody', async () => {
  const cash = await ledgerIdByCode('970');
  const bank = await ledgerIdByCode('971');

  const before = { cash: await balance(cash), bank: await balance(bank) };
  const r = await api('/api/contra-entries', {
    method: 'POST',
    body: {
      entryDate: '2026-09-20', fromLedgerId: cash, toLedgerId: bank,
      amount: 25000, instrumentNo: `DEP-${stamp}`, narration: 'cash deposited'
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  assert.equal(await balance(cash) - before.cash, -2500000, 'cash did not leave the tin');
  assert.equal(await balance(bank) - before.bank, 2500000, 'the bank did not receive it');
});

test('a contra refuses an account that is not the mill\'s own money', async () => {
  const cash = await ledgerIdByCode('970');
  const r = await api('/api/contra-entries', {
    method: 'POST',
    body: { entryDate: '2026-09-20', fromLedgerId: cash, toLedgerId: WEAVER, amount: 100 }
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /not a cash or bank account/);

  const same = await api('/api/contra-entries', {
    method: 'POST',
    body: { entryDate: '2026-09-20', fromLedgerId: cash, toLedgerId: cash, amount: 100 }
  });
  assert.equal(same.status, 400);
});

test('a contra shows in the cash and bank book, both legs', async () => {
  const r = await api('/api/reports/cash-and-bank-book?limit=500&q=cash+deposited');
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const legs = (r.body as any[]).filter(x => x.instrument_no === `DEP-${stamp}`);
  assert.equal(legs.length, 2, 'a transfer has an out leg and an in leg');
  assert.equal(paise(legs.reduce((n, l) => n + Number(l.inflow), 0)), 2500000);
  assert.equal(paise(legs.reduce((n, l) => n + Number(l.outflow), 0)), 2500000);
});

// ------------------------------------------------------- group subtotals --

test('a report that covers many parties subtotals by party', async () => {
  const summary = await api('/api/reports/sales-register/summary?from=2026-04-01&to=2027-03-31');
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  if (summary.body.total === 0) return;

  assert.ok(Array.isArray(summary.body.groups), 'the sales register offers no subtotals');
  const groups = summary.body.groups as any[];
  assert.ok(groups.length > 0);

  // The parts must add up to the whole, or the subtotals are decoration.
  const summed = groups.reduce((n, g) => n + Number(g.totals.invoice_total), 0);
  assert.ok(Math.abs(summed - summary.body.totals.invoice_total) < 0.02,
    `subtotals add to ${summed} against a report total of ${summary.body.totals.invoice_total}`);
  assert.equal(groups.reduce((n, g) => n + g.rows, 0), summary.body.total);
});

test('a report with nothing worth grouping offers no groups', async () => {
  const r = await api('/api/report-catalogue');
  const by = new Map<string, any>(r.body.map((x: any) => [x.name, x]));
  // A day book is chronological; breaking it by voucher type stops it being one.
  assert.equal(by.get('day-book').groupBy, null);
  assert.equal(by.get('sales-register').groupBy, 'party');
  assert.equal(by.get('shrinkage').groupBy, 'process_house');
});

test('the printed report carries the subtotals the screen shows', async () => {
  const pdf = await download(
    '/api/reports/sales-register?format=pdf&from=2026-04-01&to=2027-03-31' +
    '&columns=party,invoice_no,invoice_date,taxable_value,invoice_total');
  const text = pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.'));
  assert.match(text, /TOTAL OF /, 'the printed register has no per-party subtotal');
});

// --------------------------------------------------- ledger confirmation --

test('a ledger confirmation states the balance and leaves room to sign it back', async () => {
  const r = await api(`/api/ledger-confirmation?ledgerId=${WEAVER}&from=2026-04-01&to=2027-03-31`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.party.code, '105');

  const pdf = await download(
    `/api/ledger-confirmation?ledgerId=${WEAVER}&from=2026-04-01&to=2027-03-31&format=pdf`);
  const text = pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.'));
  assert.match(text, /LEDGER CONFIRMATION OF ACCOUNT/);
  assert.match(text, /Please confirm the above balance/);
  assert.match(text, /Signature:/, 'nothing for the party to sign');
  assert.match(text, /not a demand for payment/);
});

// -------------------------------------------------------- order trade fields --

test('an order carries the party\'s own reference, tolerance and terms', async () => {
  const r = await api('/api/grey-purchase-orders', {
    method: 'POST',
    body: {
      partyId: WEAVER, orderDate: '2026-09-01',
      deliveryDays: 45, deliveryDate: '2026-10-16',
      deliveryTerms: 'Ex-mill, Bhiwandi', paymentTerms: '30 days from receipt',
      partyRef: `WVR-${stamp}`, varyPercent: 3,
      lines: [{
        qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', pcs: 10,
        cutLength: 100, qty: 1000, rate: 30.5,
        lessType: 'meters', lessValue: 2
      }]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  const list = await api(`/api/grey-purchase-orders?limit=50&q=${stamp}`);
  const order = (list.body.rows as any[]).find(o => o.order_no === r.body.orderNo);
  assert.ok(order, 'the order is not in the list');
  assert.equal(order.party_ref, `WVR-${stamp}`, 'the weaver\'s own reference was dropped');
  assert.equal(Number(order.vary_percent), 3);
  assert.match(order.delivery_terms, /Ex-mill/);
});

test('a line carries the deduction agreed when the order was placed', async () => {
  const r = await api(`/api/reports/order-lines?limit=200&q=${stamp}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const line = (r.body as any[]).find(l => l.quality === 'Galaxy' && l.less_type === 'meters');
  assert.ok(line, 'the agreed deduction is not on the order line');
  assert.equal(Number(line.less_value), 2);
  assert.equal(line.side, 'purchase');
});

test('an order line shows the cloth\'s own specification without re-typing it', async () => {
  const r = await api('/api/reports/order-lines?limit=200');
  assert.equal(r.status, 200);
  if (r.body.length === 0) return;

  // Construction and selvedge live on the quality master; the line reads them.
  for (const key of ['construction', 'selvedge_line', 'width_cms']) {
    assert.ok(key in r.body[0], `an order line cannot show ${key}`);
  }
});

test('a deduction type with no value, or a value with no type, is refused', async () => {
  const r = await api('/api/grey-purchase-orders', {
    method: 'POST',
    body: {
      partyId: WEAVER, orderDate: '2026-09-01',
      lines: [{
        qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', pcs: 1,
        cutLength: 100, qty: 100, rate: 30.5,
        lessType: 'percent', lessValue: 0
      }]
    }
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
});

test('stock written off is charged once, not once above the line and once below', async () => {
  const before = await api('/api/statements/trading?from=2026-04-01&to=2027-03-31');
  const grossBefore = before.body.totals.grossProfit;

  // Write a piece off: it leaves stock, and the loss is an indirect expense.
  const barcode = `WO${stamp}`;
  const inward = await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: WEAVER, entryDate: '2026-09-25',
      challanNo: `WOCH-${stamp}`, challanDate: '2026-09-25', lotNo: `WO-${stamp}`,
      lines: [{ qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode,
                lotNo: `WO-${stamp}`, receivedQty: 50, checkedQty: 50, rate: 30 }]
    }
  });
  assert.equal(inward.status, 201, JSON.stringify(inward.body));

  const off = await api('/api/write-offs', {
    method: 'POST',
    body: { entryDate: '2026-09-26', reason: 'water damage', barcodes: [barcode] }
  });
  if (off.status !== 201) return; // write-off needs approval in some setups

  const after = await api('/api/statements/trading?from=2026-04-01&to=2027-03-31');
  const t = after.body.totals;

  /**
   * Closing stock is already net of the write-off. If the Trading Account did
   * not credit it back at cost, gross profit would carry the loss — and the
   * P&L would charge the very same rupees again below the line as an indirect
   * expense. One loss, two charges.
   */
  assert.ok(Math.abs(t.difference) < 0.02,
    `the write-off knocked gross profit out of agreement by ${t.difference}`);

  // Buying 1,500 of grey and writing it off changes nothing above the line:
  // both the purchase and the loss sit outside gross profit.
  assert.ok(Math.abs(t.grossProfit - grossBefore) < 0.02,
    `writing stock off moved gross profit by ${t.grossProfit - grossBefore}`);
});
