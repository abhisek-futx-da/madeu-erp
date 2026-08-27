/**
 * Emailing a document from the document, interest on overdue bills, and stock
 * by godown.
 *
 * The email tests deliberately never reach a mail server. This suite has no
 * SMTP credentials and must not acquire any: what is proved here is that a
 * document is queued, addressed correctly, refused where there is no address,
 * and that an unconfigured mill is told so plainly instead of watching its
 * outbox drain into nowhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMime } from '../src/smtp.ts';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const WEAVER = '33333333-0000-0000-0000-000000000105';
const CUSTOMER = '33333333-0000-0000-0000-000000000629';
const PROCESS = '33333333-0000-0000-0000-000000000202';
const GALAXY = '44444444-0000-0000-0000-000000000001';

const stamp = Date.now();
let token = '';
let invoiceId = '';

async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
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

/**
 * Masters upsert on the whole row, which is what the editor screen sends.
 * Re-reading and re-posting is the same thing a user does when they open a
 * ledger, change one field and save.
 */
async function amendLedger(code: string, change: Record<string, unknown>) {
  const list = await api('/api/ledgers?limit=500');
  const rows = Array.isArray(list.body) ? list.body : list.body.rows;
  const row = rows.find((l: any) => l.code === code);
  assert.ok(row, `no ledger with code ${code}`);
  const { id, ...rest } = row;
  return api('/api/ledgers', { method: 'POST', body: { ...rest, ...change } });
}

test('sign in', async () => {
  const r = await api('/api/auth/login', {
    method: 'POST', body: { email: 'owner@neelkamal.test', password: 'changeme' }
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  token = r.body.token;
});

test('an invoice to send', async () => {
  const barcodes = [`EM${stamp}A`, `EM${stamp}B`];
  const inward = await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: WEAVER, entryDate: '2026-08-21',
      challanNo: `EMCH-${stamp}`, challanDate: '2026-08-21', lotNo: `EM-${stamp}`,
      lines: barcodes.map(b => ({ qualityId: GALAXY, gradeCode: 'LUMP', barcode: b,
                                  lotNo: `EM-${stamp}`, receivedQty: 100, checkedQty: 100, rate: 30 }))
    }
  });
  assert.equal(inward.status, 201, JSON.stringify(inward.body));

  const issue = await api('/api/dyeing-issues', {
    method: 'POST',
    body: { processHouseId: PROCESS, entryDate: '2026-08-22', challanNo: `EMPC-${stamp}`,
            challanDate: '2026-08-22', lotNo: `EM-${stamp}`, jobRate: 18, barcodes }
  });
  assert.equal(issue.status, 201, JSON.stringify(issue.body));

  const receipt = await api('/api/dyeing-receipts', {
    method: 'POST',
    body: { processHouseId: PROCESS, entryDate: '2026-09-05', challanNo: `EMPR-${stamp}`,
            challanDate: '2026-09-05',
            lines: barcodes.map(b => ({ barcode: b, receivedQty: 100, finishGrade: 'A', jobRate: 18 })) }
  });
  assert.equal(receipt.status, 201, JSON.stringify(receipt.body));

  const dispatch = await api('/api/dispatches', {
    method: 'POST',
    body: { partyId: CUSTOMER, challanNo: `EMDC-${stamp}`, challanDate: '2026-09-10',
            lines: barcodes.map(b => ({ barcode: b, rate: 72 })) }
  });
  assert.equal(dispatch.status, 201, JSON.stringify(dispatch.body));

  const invoice = await api('/api/sales-invoices', {
    method: 'POST',
    body: { dispatchId: dispatch.body.id, invoiceDate: '2026-09-10', distanceKm: 40 }
  });
  assert.equal(invoice.status, 201, JSON.stringify(invoice.body));
  invoiceId = invoice.body.id;
});

// -------------------------------------------------------------- queueing --

test('a party with no address on file is a mistake to fix, not a mail to invent', async () => {
  const r = await api(`/api/documents/sales_invoice/${invoiceId}/email`, { method: 'POST' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /no email address on file/);
});

test('an address typed for one document is enough to queue it', async () => {
  const r = await api(`/api/documents/sales_invoice/${invoiceId}/email`, {
    method: 'POST', body: { toEmail: `buyer-${stamp}@example.test`, note: 'As discussed.' }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.state, 'pending');
  assert.equal(r.body.to, `buyer-${stamp}@example.test`);
  assert.match(r.body.subject, /Tax Invoice .* from Neelkamal/);
});

test('an unconfigured mill is told so, rather than watching mail vanish', async () => {
  const health = await api('/api/document-emails/health');
  assert.equal(health.status, 200, JSON.stringify(health.body));

  /**
   * This suite has no SMTP credentials and must never acquire any. What the
   * test holds is the honesty of the answer: unconfigured means unconfigured,
   * the queue keeps the message, and the reason names the four settings.
   */
  assert.equal(health.body.configured, false);
  assert.match(health.body.setUp, /SMTP_HOST.*SMTP_USER.*SMTP_PASS.*SMTP_FROM/);
  assert.ok(health.body.pending >= 1, 'the queued invoice is not waiting in the outbox');

  const queued = await api(`/api/documents/sales_invoice/${invoiceId}/email`, {
    method: 'POST', body: { toEmail: `second-${stamp}@example.test` }
  });
  assert.equal(queued.body.deliverable, false);
  assert.match(queued.body.message, /not configured|Nothing was sent/);
});

test('the outbox is a list like any other, searchable and dated', async () => {
  const r = await api(`/api/document-emails?limit=50&q=${stamp}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const mine = (r.body.rows as any[]).filter(x => x.to_email.includes(String(stamp)));
  assert.ok(mine.length >= 2, 'the queued mail is not listed');
  assert.equal(mine[0].state, 'pending');
  assert.equal(mine[0].doc_type, 'sales_invoice');
});

test('a document type nobody can email is refused, not queued', async () => {
  const r = await api(`/api/documents/piece_regroup/${invoiceId}/email`, { method: 'POST' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
});

test('an unknown document is a 400, not an empty mail', async () => {
  const r = await api(
    '/api/documents/sales_invoice/33333333-0000-0000-0000-999999999999/email',
    { method: 'POST', body: { toEmail: 'x@example.test' } });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /no sales invoice with that id/);
});

// ------------------------------------------------------------------ MIME --

test('the message is a real MIME document with the PDF attached', () => {
  const mime = buildMime(
    { host: 'h', port: 465, user: 'u', pass: 'p',
      from: 'mill@example.test', fromName: 'Neelkamal Textiles',
      rejectUnauthorized: true },
    {
      to: 'buyer@example.test', toName: 'Kanhaiya Textiles',
      subject: 'Tax Invoice INV-1', body: 'Please find attached.',
      attachment: { filename: 'inv-1.pdf', content: Buffer.from('%PDF-1.4 test'),
                    mime: 'application/pdf' }
    }
  );

  assert.match(mime, /^From: Neelkamal Textiles <mill@example\.test>/m);
  assert.match(mime, /^To: Kanhaiya Textiles <buyer@example\.test>/m);
  assert.match(mime, /Content-Type: multipart\/mixed; boundary="----linkerp-/);
  assert.match(mime, /Content-Disposition: attachment; filename="inv-1\.pdf"/);
  // Headers and body are CRLF-separated, or a strict server rejects the lot.
  assert.ok(mime.includes('\r\n'));
  assert.ok(!/\n(?<!\r\n)/.test(mime.replace(/\r\n/g, '')), 'a bare LF is in the message');
});

test('a name that is not ASCII survives the Subject line', () => {
  const mime = buildMime(
    { host: 'h', port: 465, user: 'u', pass: 'p', from: 'a@b.test',
      fromName: 'नीलकमल टेक्सटाइल्स', rejectUnauthorized: true },
    { to: 'x@y.test', toName: 'કનૈયા ટેક્સટાઇલ્સ',
      subject: 'चालान DC-1', body: 'x' }
  );
  // RFC 2047: a raw UTF-8 header is what makes a mail arrive as mojibake.
  assert.match(mime, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
  assert.match(mime, /^To: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <x@y\.test>$/m);
});

// -------------------------------------------------------------- interest --

test('interest is charged on the delay, never on the credit period', async () => {
  const r = await api('/api/reports/interest-receivable?limit=200');
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // No rate is set anywhere by default, and a mill that charges nothing must
  // not be shown invented income.
  assert.deepEqual(r.body, [],
    'interest appeared with no rate agreed on any party or on the mill');
});

test('the interest report is offered, and totals only what can be added up', async () => {
  const r = await api('/api/report-catalogue');
  const by = new Map<string, any>(r.body.map((x: any) => [x.name, x]));

  const interest = by.get('interest-receivable');
  assert.ok(interest, 'the interest report is not in the catalogue');
  assert.ok(interest.totals.includes('interest'));
  assert.ok(interest.totals.includes('outstanding'));
  // A rate and a day count are per bill; summing either produces nonsense.
  assert.ok(!interest.totals.includes('rate_pct'));
  assert.ok(!interest.totals.includes('overdue_days'));
  assert.equal(interest.groupBy, 'party');
});

// ------------------------------------------------------------- by godown --

test('stock can be read one godown at a time', async () => {
  const r = await api('/api/reports/stock-by-location?limit=200');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (r.body.length === 0) return;

  for (const key of ['location', 'location_code', 'location_kind', 'pcs', 'qty', 'total_cost']) {
    assert.ok(key in r.body[0], `stock by godown cannot show ${key}`);
  }

  // The godowns must add up to the whole, or the split is decoration.
  const byLocation = await api('/api/reports/stock-by-location/summary');
  const overall = await api('/api/reports/stock-summary/summary');
  assert.equal(Number(byLocation.body.totals.pcs), Number(overall.body.totals.pcs),
    'the godowns do not add up to the stock summary');
});

test('a piece with no godown is shown as unassigned, not dropped', async () => {
  const r = await api('/api/reports/stock-by-location?limit=200');
  const rows = r.body as any[];
  if (rows.length === 0) return;
  // Whatever the label, nothing may be silently missing from a stock report.
  assert.ok(rows.every(x => x.location && x.location_code),
    'a row has no godown at all, which means stock has gone missing from the report');
});

test('with a rate agreed, the interest is simple interest on the days run over', async () => {
  // 12% a year on a customer who takes his time.
  const set = await amendLedger('629', { interest_rate_pct: 12, credit_days: 30 });
  assert.equal(set.status, 201, JSON.stringify(set.body));

  const r = await api('/api/reports/interest-receivable?limit=200');
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const bills = (r.body as any[]).filter(x => x.party_code === '629');
  if (bills.length === 0) return; // nothing overdue yet in this window

  for (const bill of bills) {
    assert.equal(Number(bill.rate_pct), 12);
    // Simple interest: outstanding x rate x days / 365, and the days are
    // counted from the due date, so the agreed credit period is never charged.
    const expected =
      Math.round(Number(bill.outstanding) * 12 / 100 * Number(bill.overdue_days) / 365 * 100) / 100;
    assert.ok(Math.abs(Number(bill.interest) - expected) < 0.02,
      `interest on ${bill.invoice_no} is ${bill.interest}, expected ${expected}`);

    const due = new Date(bill.due_date).getTime();
    const invoiced = new Date(bill.invoice_date).getTime();
    assert.ok(due >= invoiced, 'a bill fell due before it was raised');
  }
});

test('the mill can carry an address for a party, so a bill can reach them', async () => {
  const set = await amendLedger('629', { email: `accounts-${stamp}@kanhaiya.test` });
  assert.equal(set.status, 201, JSON.stringify(set.body));

  // With an address on file, no one has to type it per document any more.
  const r = await api(`/api/documents/sales_invoice/${invoiceId}/email`, { method: 'POST' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.to, `accounts-${stamp}@kanhaiya.test`);
});

test('an address that is not an address is refused by the ledger itself', async () => {
  // The whole row, so the refusal is the address check and nothing else.
  const r = await amendLedger('629', { email: 'not an address' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /ledger_email_shape|business rule/,
    `refused, but not for the address: ${r.body.error}`);
});
