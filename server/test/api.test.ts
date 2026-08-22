/**
 * End-to-end lifecycle against a real Postgres: grey in -> dyeing -> finish
 * back -> dispatch, then the traceability and accounting that must follow.
 * Run with a rebuilt+seeded database; see db/rebuild.sh.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const TENANT = '11111111-1111-1111-1111-111111111111';

const PARTY_WEAVER = '33333333-0000-0000-0000-000000000105'; // L.R. Textiles
const PROCESS_HOUSE = '33333333-0000-0000-0000-000000000202'; // Prayag Texprint
const CUSTOMER = '33333333-0000-0000-0000-000000000701'; // Supreme Textile
const QUALITY_GALAXY = '44444444-0000-0000-0000-000000000001';

let ownerToken = '';
let storeToken = '';
let viewerToken = '';

const stamp = Date.now();
const barcodes = [0, 1, 2].map(i => `TST${stamp}${i}`);

async function api(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {}
) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {})
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

test('health check responds', async () => {
  const r = await fetch(`${BASE}/health`);
  assert.equal(r.status, 200);
});

test('login issues a token; bad credentials do not', async () => {
  const bad = await api('/api/auth/login', {
    method: 'POST', body: { email: 'owner@neelkamal.test', password: 'wrong' }
  });
  assert.equal(bad.status, 401);

  const noUser = await api('/api/auth/login', {
    method: 'POST', body: { email: 'nobody@neelkamal.test', password: 'changeme' }
  });
  assert.equal(noUser.status, 401);

  for (const [email, sink] of [
    ['owner@neelkamal.test', (t: string) => (ownerToken = t)],
    ['store@neelkamal.test', (t: string) => (storeToken = t)],
    ['viewer@neelkamal.test', (t: string) => (viewerToken = t)]
  ] as const) {
    const ok = await api('/api/auth/login', {
      method: 'POST', body: { email, password: 'changeme' }
    });
    assert.equal(ok.status, 200, `${email} should log in`);
    assert.ok(ok.body.token, 'token expected');
    sink(ok.body.token);
  }
});

test('the web session is HttpOnly and can be revoked without browser storage', async () => {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@neelkamal.test', password: 'changeme' })
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /link_erp_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookie = setCookie.split(';')[0] ?? '';
  assert.ok(cookie, 'login must return a usable session cookie');

  const signedIn = await fetch(`${BASE}/api/me`, { headers: { cookie } });
  assert.equal(signedIn.status, 200, 'the browser cookie authenticates without a bearer header');

  const loggedOut = await fetch(`${BASE}/api/auth/logout`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(loggedOut.status, 200);
  const cleared = loggedOut.headers.get('set-cookie') ?? '';
  assert.match(cleared, /link_erp_session=;/);
  assert.match(cleared, /Expires=Thu, 01 Jan 1970/i);

  const revoked = await fetch(`${BASE}/api/me`, { headers: { cookie } });
  assert.equal(revoked.status, 401, 'logging out revokes the session even if an old cookie is replayed');
});

test('unauthenticated requests are refused', async () => {
  const r = await api('/api/ledgers');
  assert.equal(r.status, 401);
});

test('a forged token is refused', async () => {
  const r = await api('/api/ledgers', { token: 'not.a.real.token' });
  assert.equal(r.status, 401);
});

test('seeded masters are readable and searchable', async () => {
  const all = await api('/api/ledgers', { token: ownerToken });
  assert.equal(all.status, 200);
  assert.ok(all.body.length >= 8, `expected seeded ledgers, got ${all.body.length}`);

  const hit = await api('/api/ledgers?q=Prayag', { token: ownerToken });
  assert.equal(hit.status, 200);
  assert.equal(hit.body.length, 1);
  assert.equal(hit.body[0].name, 'Prayag Texprint Llp');
});

test('a viewer cannot write masters', async () => {
  const r = await api('/api/qualities', {
    method: 'POST', token: viewerToken,
    body: { code: 'X1', name: 'Should Not Save', hsn_code: '551311' }
  });
  assert.equal(r.status, 403);
});

test('an owner can upsert a quality, and re-saving does not duplicate it', async () => {
  const first = await api('/api/qualities', {
    method: 'POST', token: ownerToken,
    body: { code: 'T1', name: 'Test Quality', hsn_code: '551311', division: 'Shirting' }
  });
  assert.equal(first.status, 201);

  const again = await api('/api/qualities', {
    method: 'POST', token: ownerToken,
    body: { code: 'T1', name: 'Test Quality Renamed', hsn_code: '551311' }
  });
  assert.equal(again.status, 201);
  assert.equal(again.body.id, first.body.id, 'same row, not a duplicate');
  assert.equal(again.body.name, 'Test Quality Renamed');
});

test('a bad GSTIN is refused by the database, surfaced as 400', async () => {
  const r = await api('/api/ledgers', {
    method: 'POST', token: ownerToken,
    body: {
      code: 'BAD1', name: 'Bad GSTIN Co', gstin: 'NOTAGSTIN',
      control_account_id: '22222222-0000-0000-0000-000000000040'
    }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /business rule|gstin/i);
});

// ---------------------------------------------------------------- lifecycle --

let inwardId = '';

test('grey inward creates one piece per thaan and posts a purchase voucher', async () => {
  const r = await api('/api/grey-inwards', {
    method: 'POST', token: storeToken,
    body: {
      partyId: PARTY_WEAVER,
      entryDate: '2026-08-21',
      challanNo: `CH-${stamp}`,
      challanDate: '2026-08-21',
      lotNo: '1100/B',
      lines: barcodes.map(b => ({
        qualityId: QUALITY_GALAXY,
        gradeCode: 'LUMP',
        barcode: b,
        lotNo: '1100/B',
        receivedQty: 118,
        checkedQty: 118,
        rate: 30.5
      }))
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.pieces, 3);
  assert.equal(r.body.value, 10797); // 3 x 118 x 30.50
  inwardId = r.body.id;

  const pieces = await api(`/api/pieces?status=grey_in_stock&lotNo=1100/B`, { token: storeToken });
  const mine = pieces.body.filter((p: any) => barcodes.includes(p.barcode));
  assert.equal(mine.length, 3);
});

test('the same challan cannot be booked twice', async () => {
  const r = await api('/api/grey-inwards', {
    method: 'POST', token: storeToken,
    body: {
      partyId: PARTY_WEAVER, entryDate: '2026-08-21',
      challanNo: `CH-${stamp}`, challanDate: '2026-08-21', lotNo: '1100/B',
      lines: [{
        qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode: `DUP${stamp}`,
        lotNo: '1100/B', receivedQty: 10, checkedQty: 10, rate: 1
      }]
    }
  });
  assert.equal(r.status, 409);
});

test('issue to dyeing moves the pieces to the process house', async () => {
  const r = await api('/api/dyeing-issues', {
    method: 'POST', token: storeToken,
    body: {
      processHouseId: PROCESS_HOUSE,
      entryDate: '2026-08-22',
      challanNo: `PC-${stamp}`,
      challanDate: '2026-08-22',
      lotNo: '1100/B',
      jobRate: 18,
      barcodes
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.pieces, 3);

  const stock = await api('/api/reports/process-stock', { token: storeToken });
  const row = stock.body.find((s: any) => s.process_house === 'Prayag Texprint Llp');
  assert.ok(row, 'pieces should now show as lying at the process house');
});

test('issuing the same piece twice is refused', async () => {
  const r = await api('/api/dyeing-issues', {
    method: 'POST', token: storeToken,
    body: {
      processHouseId: PROCESS_HOUSE, entryDate: '2026-08-22',
      challanNo: `PC2-${stamp}`, challanDate: '2026-08-22', lotNo: '1100/B',
      barcodes: [barcodes[0]!]
    }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not in grey stock/i);
});

test('dyeing receipt reconciles shrinkage and posts jobwork', async () => {
  const r = await api('/api/dyeing-receipts', {
    method: 'POST', token: storeToken,
    body: {
      processHouseId: PROCESS_HOUSE,
      entryDate: '2026-09-05',
      challanNo: `PR-${stamp}`,
      challanDate: '2026-09-05',
      lines: barcodes.map(b => ({
        barcode: b, receivedQty: 112.1, finishGrade: 'A', jobRate: 18
      }))
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.issuedQty, 354);       // 3 x 118
  assert.equal(r.body.receivedQty, 336.3);   // 3 x 112.10
  assert.equal(r.body.shrinkagePct, 5);      // exactly 5%
  assert.equal(r.body.jobwork, 6053.4);      // 336.30 x 18
});

test('a piece cannot come back from a process house it never went to', async () => {
  const r = await api('/api/dyeing-receipts', {
    method: 'POST', token: storeToken,
    body: {
      processHouseId: '33333333-0000-0000-0000-000000000201', // Bombay Crimpers
      entryDate: '2026-09-05', challanNo: `PRX-${stamp}`, challanDate: '2026-09-05',
      lines: [{ barcode: barcodes[0]!, receivedQty: 100, finishGrade: 'A', jobRate: 18 }]
    }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown or unavailable/i);
});

test('dispatch requires the sales role', async () => {
  const r = await api('/api/dispatches', {
    method: 'POST', token: storeToken,
    body: {
      partyId: CUSTOMER, challanNo: `DC-${stamp}`, challanDate: '2026-09-10',
      lines: [{ barcode: barcodes[0]!, rate: 72 }]
    }
  });
  assert.equal(r.status, 403);
});

test('dispatch ships the finish and posts a sales voucher', async () => {
  const r = await api('/api/dispatches', {
    method: 'POST', token: ownerToken,
    body: {
      partyId: CUSTOMER,
      challanNo: `DC-${stamp}`,
      challanDate: '2026-09-10',
      lines: barcodes.map(b => ({ barcode: b, rate: 72 }))
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.pieces, 3);
  assert.equal(r.body.value, 24213.6); // 336.30 x 72
});

test('one piece carries its whole life story', async () => {
  const r = await api(`/api/pieces/${barcodes[0]}/history`, { token: ownerToken });
  assert.equal(r.status, 200);
  const events = r.body.map((e: any) => e.event);
  assert.deepEqual(events, ['inward', 'issue', 'receipt', 'pack', 'dispatch']);

  const last = r.body.at(-1);
  assert.equal(last.to_status, 'dispatched');
  assert.equal(last.counterparty, 'Supreme Textile And Garments');
});

test('a dispatch moves goods without recognising revenue', async () => {
  // Revenue belongs to the tax invoice. Posting it here too doubled both the
  // receivable and the sales figure while still leaving the books balanced.
  const before = await api('/api/reports/party-balance', { token: ownerToken });
  const customerBefore = Number(
    before.body.find((x: any) => x.code === '701')?.balance ?? 0
  );

  const dispatches = await api('/api/dispatches?uninvoiced=true', { token: ownerToken });
  const mine = dispatches.body.rows.find((d: any) => d.challan_no === `DC-${stamp}`);
  assert.ok(mine, 'our dispatch should still be awaiting an invoice');

  const inv = await api('/api/sales-invoices', {
    method: 'POST', token: ownerToken, body: { dispatchId: mine.id }
  });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));

  const after = await api('/api/reports/party-balance', { token: ownerToken });
  const customerAfter = Number(after.body.find((x: any) => x.code === '701').balance);

  // The customer is charged exactly the invoice total, not that plus a dispatch.
  assert.ok(
    Math.abs((customerAfter - customerBefore) - inv.body.invoiceTotal) < 0.01,
    `receivable moved by ${customerAfter - customerBefore}, invoice was ${inv.body.invoiceTotal}`
  );
});

test('the ledger balances across the whole lifecycle', async () => {
  const r = await api('/api/reports/party-balance', { token: ownerToken });
  assert.equal(r.status, 200);
  const total = r.body.reduce((n: number, row: any) => n + Number(row.balance), 0);
  assert.ok(Math.abs(total) < 0.01, `books must balance, drift was ${total}`);

  const weaver = r.body.find((x: any) => x.code === '105');
  assert.ok(weaver.balance < 0, 'the weaver we bought grey from should be a creditor');

  const customer = r.body.find((x: any) => x.code === '701');
  assert.ok(customer.balance > 0, 'the customer we sold to should be a debtor');
});

/**
 * The defect this guards: dispatch used to post revenue *and* the invoice
 * posted it again, so the sales ledger carried twice what was billed. The
 * books still balanced, which is why nothing caught it.
 *
 * Measured as a delta across one cycle rather than as a global equality —
 * the old version compared two whole-database aggregates and so broke the
 * moment anyone cancelled anything.
 */
test('a dispatch and its invoice together recognise revenue exactly once', async () => {
  const salesBalance = async () => {
    const r = await api('/api/reports/party-balance', { token: ownerToken });
    return -Number(r.body.find((x: any) => x.code === '901')?.balance ?? 0);
  };

  const before = await salesBalance();

  const tag = `REV${Date.now()}`;
  const barcode = `${tag}0`;
  await api('/api/grey-inwards', {
    method: 'POST', token: ownerToken,
    body: {
      partyId: PARTY_WEAVER, entryDate: '2026-08-21', challanNo: `${tag}-IN`,
      challanDate: '2026-08-21', lotNo: tag,
      lines: [{ qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode, lotNo: tag,
                receivedQty: 100, checkedQty: 100, rate: 30 }]
    }
  });
  await api('/api/dyeing-issues', {
    method: 'POST', token: ownerToken,
    body: { processHouseId: PROCESS_HOUSE, entryDate: '2026-08-22', challanNo: `${tag}-PC`,
            challanDate: '2026-08-22', lotNo: tag, jobRate: 18, barcodes: [barcode] }
  });
  await api('/api/dyeing-receipts', {
    method: 'POST', token: ownerToken,
    body: { processHouseId: PROCESS_HOUSE, entryDate: '2026-09-05', challanNo: `${tag}-PR`,
            challanDate: '2026-09-05',
            lines: [{ barcode, receivedQty: 95, finishGrade: 'A', jobRate: 18 }] }
  });
  const dispatch = await api('/api/dispatches', {
    method: 'POST', token: ownerToken,
    body: { partyId: CUSTOMER, challanNo: `${tag}-DC`, challanDate: '2026-09-10',
            lines: [{ barcode, rate: 80 }] }
  });
  assert.equal(dispatch.status, 201);

  // Moving goods is not a sale; only the invoice is.
  assert.equal(await salesBalance(), before, 'the dispatch alone moved the sales ledger');

  const invoice = await api('/api/sales-invoices', {
    method: 'POST', token: ownerToken, body: { dispatchId: dispatch.body.id }
  });
  assert.equal(invoice.status, 201);

  const after = await salesBalance();
  assert.ok(
    Math.abs((after - before) - Number(invoice.body.taxableValue)) < 0.01,
    `sales moved by ${after - before}, invoice was ${invoice.body.taxableValue}`
  );
});

test('shrinkage is reportable by process house', async () => {
  const r = await api('/api/reports/shrinkage', { token: ownerToken });
  const row = r.body.find((x: any) => x.process_house === 'Prayag Texprint Llp');
  assert.ok(row, 'expected a shrinkage row');

  // The exact percentage is an aggregate other suites also contribute to, so
  // assert the report is internally consistent rather than a fixed number.
  const issued = Number(row.issued_qty);
  const received = Number(row.received_qty);
  assert.ok(received <= issued, 'cannot receive more than was issued');
  assert.equal(
    Number(row.shrinkage_pct),
    Math.round(((issued - received) * 100 / issued) * 1000) / 1000
  );
  // This run's own receipt was exactly 5%, asserted where it is posted.
});

test('validation rejects a malformed document before it reaches the database', async () => {
  const r = await api('/api/grey-inwards', {
    method: 'POST', token: storeToken,
    body: { partyId: 'not-a-uuid', entryDate: '21/08/2026', lines: [] }
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'validation failed');
});
