/**
 * The process-house portal.
 *
 * This is the only place an account outside the company can reach the system,
 * so most of these tests are attacks rather than features: a staff token used
 * on the portal, a portal token used on the mill's API, one process house
 * asking about another's goods, and an outside login trying to move stock.
 *
 * The feature itself is small. The boundary is the product.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';

const PARTY_WEAVER = '33333333-0000-0000-0000-000000000105';
const PRAYAG = '33333333-0000-0000-0000-000000000202';
const BOMBAY_CRIMPERS = '33333333-0000-0000-0000-000000000201';
const QUALITY_GALAXY = '44444444-0000-0000-0000-000000000001';

const stamp = Date.now();
const staff: Record<string, string> = {};
let prayagToken = '';
let crimpersToken = '';

async function call(
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

const api = (path: string, opts: { method?: string; body?: unknown; as?: string } = {}) =>
  call(`/api${path}`, { ...opts, token: staff[opts.as ?? 'owner'] });

const portal = (path: string, opts: { method?: string; body?: unknown; token?: string } = {}) =>
  call(`/api/portal${path}`, { ...opts, token: opts.token ?? prayagToken });

/** Grey in, then straight out to a named process house. */
async function issueTo(processHouseId: string, barcodes: string[], tag: string) {
  const lot = `PH-${tag}`;
  const made = await api('/grey-inwards', {
    method: 'POST', as: 'store',
    body: {
      partyId: PARTY_WEAVER, entryDate: '2026-08-21',
      challanNo: `PHIN-${tag}`, challanDate: '2026-08-21', lotNo: lot, rackCode: 'A1',
      lines: barcodes.map(b => ({
        qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode: b, lotNo: lot,
        receivedQty: 100, checkedQty: 100, rate: 30
      }))
    }
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));

  const issued = await api('/dyeing-issues', {
    method: 'POST', as: 'store',
    body: {
      processHouseId, entryDate: '2026-08-22',
      challanNo: `PC-${tag}`, challanDate: '2026-08-22', lotNo: lot,
      jobRate: 18, barcodes
    }
  });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  return issued.body.id as string;
}

const PRAYAG_CODES = [`PP${stamp}A`, `PP${stamp}B`, `PP${stamp}C`];
const CRIMPER_CODES = [`CC${stamp}A`, `CC${stamp}B`];

// -------------------------------------------------------------------- setup --

test('sign in as the mill', async () => {
  for (const who of ['owner', 'store', 'accounts']) {
    const r = await call('/api/auth/login', {
      method: 'POST', body: { email: `${who}@neelkamal.test`, password: 'changeme' }
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    staff[who] = r.body.token;
  }
});

test('the owner gives two process houses a login of their own', async () => {
  for (const [partyId, name] of [[PRAYAG, 'prayag'], [BOMBAY_CRIMPERS, 'crimpers']] as const) {
    const r = await api('/portal-users', {
      method: 'POST',
      body: {
        email: `${name}${stamp}@process.test`,
        fullName: `${name} dispatch desk`,
        partyId,
        password: 'a-long-enough-portal-password'
      }
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }

  const list = await api('/portal-users');
  assert.ok((list.body as any[]).some(u => u.email === `prayag${stamp}@process.test`));
});

test('a mill user\'s address cannot be turned into an outside login', async () => {
  const r = await api('/portal-users', {
    method: 'POST',
    body: {
      email: 'store@neelkamal.test', fullName: 'sneaky', partyId: PRAYAG,
      password: 'a-long-enough-portal-password'
    }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already belongs to a mill user/);
});

test('only the owner may create a process-house login', async () => {
  const r = await api('/portal-users', {
    method: 'POST', as: 'store',
    body: {
      email: `nope${stamp}@process.test`, fullName: 'x', partyId: PRAYAG,
      password: 'a-long-enough-portal-password'
    }
  });
  assert.equal(r.status, 403);
});

test('the process houses sign in', async () => {
  for (const [name, sink] of [
    ['prayag', (t: string) => (prayagToken = t)],
    ['crimpers', (t: string) => (crimpersToken = t)]
  ] as const) {
    const r = await call('/api/portal/auth/login', {
      method: 'POST',
      body: { email: `${name}${stamp}@process.test`, password: 'a-long-enough-portal-password' }
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mill, 'Neelkamal Textiles');
    sink(r.body.token);
  }
  const me = await portal('/me');
  assert.equal(me.body.partyId, PRAYAG);
  assert.equal(me.body.kind, 'process_house');
});

test('a wrong portal password is refused', async () => {
  const r = await call('/api/portal/auth/login', {
    method: 'POST', body: { email: `prayag${stamp}@process.test`, password: 'wrong' }
  });
  assert.equal(r.status, 401);
});

// ------------------------------------------------------------- the boundary --

test('a mill token cannot open the portal', async () => {
  for (const who of ['owner', 'store']) {
    const r = await portal('/challans', { token: staff[who] });
    assert.equal(r.status, 403, `${who} reached the portal`);
    assert.match(r.body.error, /not a process-house account/);
  }
});

test('a portal token cannot touch the mill application', async () => {
  for (const path of ['/pieces', '/sales-invoices', '/dashboard', '/portal-users']) {
    const r = await api(path, { as: 'nobody' });
    void r;
  }
  for (const path of ['/pieces', '/dashboard', '/stock-counts', '/party-declarations']) {
    const r = await call(`/api${path}`, { token: prayagToken });
    assert.equal(r.status, 403, `a portal token reached ${path}`);
    assert.match(r.body.error, /cannot use the mill application/);
  }
});

test('the portal offers no way to move a piece', async () => {
  const attempts = [
    ['POST', '/pieces'],
    ['POST', '/dyeing-receipts'],
    ['POST', '/stock-counts'],
    ['POST', '/pieces/merge']
  ] as const;
  for (const [method, path] of attempts) {
    const r = await portal(path, { method, body: {} });
    assert.equal(r.status, 404, `${method} ${path} exists on the portal`);
  }
});

// ------------------------------------------------------------- what they see --

let prayagIssue = '';
let crimpersIssue = '';

test('each process house sees its own custody and nobody else\'s', async () => {
  prayagIssue = await issueTo(PRAYAG, PRAYAG_CODES, `${stamp}P`);
  crimpersIssue = await issueTo(BOMBAY_CRIMPERS, CRIMPER_CODES, `${stamp}C`);

  const mine = await portal('/pieces');
  assert.equal(mine.status, 200);
  const barcodes = (mine.body as any[]).map(p => p.barcode);
  for (const b of PRAYAG_CODES) assert.ok(barcodes.includes(b), `${b} missing from its own portal`);
  for (const b of CRIMPER_CODES) {
    assert.ok(!barcodes.includes(b), `${b} leaked to the wrong process house`);
  }

  const theirs = await portal('/pieces', { token: crimpersToken });
  const theirBarcodes = (theirs.body as any[]).map(p => p.barcode);
  for (const b of PRAYAG_CODES) assert.ok(!theirBarcodes.includes(b), `${b} leaked the other way`);
});

test('the challan list shows what is owed back, and what has been acknowledged', async () => {
  const r = await portal('/challans');
  const mine = (r.body as any[]).find(c => c.issue_id === prayagIssue);
  assert.ok(mine, 'the challan is not on the portal');
  assert.equal(Number(mine.pieces), 3);
  assert.equal(Number(mine.issued_qty), 300);
  assert.equal(mine.acknowledged_at, null);

  assert.ok(!(r.body as any[]).some(c => c.issue_id === crimpersIssue),
    'another house\'s challan is visible');
});

// ------------------------------------------------------------ what they say --

test('custody is acknowledged, and the challan says so afterwards', async () => {
  const r = await portal('/declarations', {
    method: 'POST',
    body: { kind: 'custody_ack', issueId: prayagIssue, theirRef: 'GRN-4471', note: '3 thaans, 1 bale' }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  const challans = await portal('/challans');
  const mine = (challans.body as any[]).find(c => c.issue_id === prayagIssue);
  assert.ok(mine.acknowledged_at, 'the acknowledgement did not reach the challan');
});

test('a process house cannot speak about another\'s challan', async () => {
  const r = await portal('/declarations', {
    method: 'POST',
    body: { kind: 'custody_ack', issueId: crimpersIssue, note: 'not mine' }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not one of yours/);
});

test('a shortage must name thaans, and only thaans it is holding', async () => {
  const noLines = await portal('/declarations', {
    method: 'POST', body: { kind: 'shortage', issueId: prayagIssue, note: 'some are short' }
  });
  assert.equal(noLines.status, 400);
  assert.match(noLines.body.error, /name the thaans/);

  const notMine = await portal('/declarations', {
    method: 'POST',
    body: {
      kind: 'shortage', issueId: prayagIssue, note: 'x',
      lines: [{ barcode: CRIMPER_CODES[0]!, qty: 10 }]
    }
  });
  assert.equal(notMine.status, 400);
  assert.match(notMine.body.error, /not in your custody/);
});

test('a rejection is filed against real pieces with a reason', async () => {
  const r = await portal('/declarations', {
    method: 'POST',
    body: {
      kind: 'rejection', issueId: prayagIssue, note: 'off-shade after first bath',
      lines: [{ barcode: PRAYAG_CODES[0]!, qty: 100, reason: 'shade mismatch' }]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.pieces, 1);
});

test('an expected return needs a date', async () => {
  const missing = await portal('/declarations', {
    method: 'POST', body: { kind: 'expected_return', issueId: prayagIssue }
  });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /date you expect/);

  const ok = await portal('/declarations', {
    method: 'POST',
    body: { kind: 'expected_return', issueId: prayagIssue, expectedOn: '2026-09-08' }
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));

  const challans = await portal('/challans');
  const mine = (challans.body as any[]).find(c => c.issue_id === prayagIssue);
  assert.equal(mine.expected_on, '2026-09-08');
});

test('a return dispatch carries their challan and vehicle', async () => {
  const r = await portal('/declarations', {
    method: 'POST',
    body: {
      kind: 'return_dispatch', issueId: prayagIssue, theirRef: 'PTX/812',
      vehicleNo: 'MH04AB1234', note: 'sent this evening',
      lines: PRAYAG_CODES.slice(1).map(b => ({ barcode: b, qty: 97 }))
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.pieces, 2);
});

test('a process house sees its own declarations and their state', async () => {
  const r = await portal('/declarations');
  assert.equal(r.status, 200);
  const kinds = (r.body as any[]).map(d => d.kind);
  for (const k of ['custody_ack', 'rejection', 'expected_return', 'return_dispatch']) {
    assert.ok(kinds.includes(k), `${k} missing`);
  }
  assert.ok((r.body as any[]).every(d => d.state === 'submitted'));

  // Crimpers filed nothing, and must see nothing.
  const theirs = await portal('/declarations', { token: crimpersToken });
  assert.deepEqual(theirs.body, []);
});

// ------------------------------------------------------- what the mill says --

let rejectionId = '';

test('the mill sees every declaration waiting on it', async () => {
  const r = await api('/party-declarations', { as: 'store' });
  assert.equal(r.status, 200);
  const mine = (r.body as any[]).filter(d => d.party === 'Prayag Texprint Llp');
  assert.ok(mine.length >= 4, `only ${mine.length} declarations in the inbox`);
  assert.ok(mine.every(d => d.state === 'submitted'));

  const rejection = mine.find(d => d.kind === 'rejection');
  assert.ok(rejection);
  rejectionId = rejection.declaration_id;
});

test('a declaration opens with its pieces and its history', async () => {
  const r = await api(`/party-declarations/${rejectionId}`, { as: 'store' });
  assert.equal(r.status, 200);
  assert.equal(r.body.lines.length, 1);
  assert.equal(r.body.lines[0].barcode, PRAYAG_CODES[0]);
  assert.equal(r.body.lines[0].reason, 'shade mismatch');
  assert.deepEqual(r.body.history, []);
});

test('the store answers it, and the process house sees the answer', async () => {
  const r = await api(`/party-declarations/${rejectionId}/accept`, {
    method: 'POST', as: 'store', body: { note: 'agreed, will re-process' }
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, 'accepted');

  const theirs = await portal('/declarations');
  const seen = (theirs.body as any[]).find(d => d.declaration_id === rejectionId);
  assert.equal(seen.state, 'accepted');
  assert.equal(seen.mill_note, 'agreed, will re-process');
});

test('a declaration cannot be answered twice', async () => {
  const r = await api(`/party-declarations/${rejectionId}/reject`, {
    method: 'POST', as: 'store', body: { note: 'changed my mind' }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already accepted/);
});

test('the answer is an event, so what was said survives', async () => {
  const r = await api(`/party-declarations/${rejectionId}`, { as: 'store' });
  assert.equal(r.body.history.length, 1);
  assert.equal(r.body.history[0].state, 'accepted');
  assert.equal(r.body.history[0].actor, 'Store Keeper');
});

// ------------------------------------------------------------- taking it away --

test('disabling the login locks the process house out at once', async () => {
  const users = await api('/portal-users');
  const prayagUser = (users.body as any[]).find(u => u.email === `prayag${stamp}@process.test`);
  const off = await api(`/portal-users/${prayagUser.user_id}/disable`, { method: 'POST' });
  assert.equal(off.status, 200);

  // The token is still cryptographically valid; the binding is not.
  const r = await portal('/challans');
  assert.equal(r.status, 403);
  assert.match(r.body.error, /no longer works for that company/);
});
