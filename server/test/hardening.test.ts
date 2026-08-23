/**
 * The things that only break under real load or a real attacker: concurrent
 * writes racing for the same piece or document number, tenant isolation under
 * a hostile token, injection through every string that reaches SQL, and a
 * batch big enough to expose an N+1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const WEAVER = '33333333-0000-0000-0000-000000000105';
const PROCESS = '33333333-0000-0000-0000-000000000202';
const GALAXY = '44444444-0000-0000-0000-000000000001';
const TENANT = '11111111-1111-1111-1111-111111111111';

let owner = '';
let store = '';
const stamp = Date.now();

async function api(path: string, opts: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.token ?? owner}`,
      ...opts.headers
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

// ------------------------------------------------------------ concurrency --

test('concurrent inwards never collide on a document number', async () => {
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      api('/api/grey-inwards', {
        method: 'POST', token: store,
        body: {
          partyId: WEAVER, entryDate: '2026-08-21',
          challanNo: `RACE-${stamp}-${i}`, challanDate: '2026-08-21', lotNo: 'RACE',
          lines: [{
            qualityId: GALAXY, gradeCode: 'LUMP', barcode: `RACE${stamp}${i}`,
            lotNo: 'RACE', receivedQty: 50, checkedQty: 50, rate: 30
          }]
        }
      })
    )
  );
  const ok = results.filter(r => r.status === 201);
  assert.equal(ok.length, 12, JSON.stringify(results.find(r => r.status !== 201)?.body));

  const numbers = ok.map(r => r.body.entryNo);
  assert.equal(new Set(numbers).size, 12, `document numbers repeated: ${numbers.join(',')}`);
});

test('two challans cannot claim the same piece', async () => {
  const barcode = `LOCK${stamp}`;
  const inward = await api('/api/grey-inwards', {
    method: 'POST', token: store,
    body: {
      partyId: WEAVER, entryDate: '2026-08-21', challanNo: `LOCKCH-${stamp}`,
      challanDate: '2026-08-21', lotNo: 'LOCK',
      lines: [{
        qualityId: GALAXY, gradeCode: 'LUMP', barcode, lotNo: 'LOCK',
        receivedQty: 100, checkedQty: 100, rate: 30
      }]
    }
  });
  assert.equal(inward.status, 201);

  // Same piece, two simultaneous issues. Exactly one may win.
  const both = await Promise.all([0, 1].map(i =>
    api('/api/dyeing-issues', {
      method: 'POST', token: store,
      body: {
        processHouseId: PROCESS, entryDate: '2026-08-22',
        challanNo: `LOCKPC-${stamp}-${i}`, challanDate: '2026-08-22',
        lotNo: 'LOCK', jobRate: 18, barcodes: [barcode]
      }
    })
  ));
  const won = both.filter(r => r.status === 201);
  assert.equal(won.length, 1, `expected exactly one winner, got ${won.length}`);
});

test('a piece cannot be dispatched twice concurrently', async () => {
  const barcode = `DUP${stamp}`;
  await api('/api/grey-inwards', {
    method: 'POST', token: store,
    body: {
      partyId: WEAVER, entryDate: '2026-08-21', challanNo: `DUPCH-${stamp}`,
      challanDate: '2026-08-21', lotNo: 'DUP',
      lines: [{
        qualityId: GALAXY, gradeCode: 'LUMP', barcode, lotNo: 'DUP',
        receivedQty: 100, checkedQty: 100, rate: 30
      }]
    }
  });
  await api('/api/dyeing-issues', {
    method: 'POST', token: store,
    body: {
      processHouseId: PROCESS, entryDate: '2026-08-22', challanNo: `DUPPC-${stamp}`,
      challanDate: '2026-08-22', lotNo: 'DUP', jobRate: 18, barcodes: [barcode]
    }
  });
  await api('/api/dyeing-receipts', {
    method: 'POST', token: store,
    body: {
      processHouseId: PROCESS, entryDate: '2026-09-05', challanNo: `DUPPR-${stamp}`,
      challanDate: '2026-09-05',
      lines: [{ barcode, receivedQty: 95, finishGrade: 'A', jobRate: 18 }]
    }
  });

  const both = await Promise.all([0, 1].map(i =>
    api('/api/dispatches', {
      method: 'POST',
      body: {
        partyId: '33333333-0000-0000-0000-000000000701',
        challanNo: `DUPDC-${stamp}-${i}`, challanDate: '2026-09-10',
        lines: [{ barcode, rate: 80 }]
      }
    })
  ));
  assert.equal(both.filter(r => r.status === 201).length, 1);
});

// -------------------------------------------------------------- security --

test('a token signed with the wrong secret is refused', async () => {
  const forged = jwt.sign(
    { userId: 'aaaaaaaa-0000-0000-0000-000000000001', tenantId: TENANT, role: 'owner' },
    'not-the-real-secret'
  );
  const r = await api('/api/ledgers', { token: forged });
  assert.equal(r.status, 401);
});

test('a planned signing-key rotation does not throw active users out', async () => {
  const previous = (process.env.JWT_PREVIOUS_SECRETS ?? '').split(',')[0]?.trim();
  assert.ok(previous, 'the test server needs one previous signing key');
  const decoded = jwt.decode(owner) as jwt.JwtPayload;
  const { iat: _iat, exp: _exp, ...claims } = decoded;
  const rotating = jwt.sign(claims, previous, { expiresIn: '1h', keyid: 'previous' });
  const r = await api('/api/ledgers?limit=1', { token: rotating });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('every response has a safe trace id and preserves a valid caller id', async () => {
  const generated = await fetch(`${BASE}/health`);
  assert.match(generated.headers.get('x-request-id') ?? '', /^[A-Za-z0-9._:-]{1,100}$/);

  const supplied = await fetch(`${BASE}/health`, { headers: { 'x-request-id': 'mill-incident-42' } });
  assert.equal(supplied.headers.get('x-request-id'), 'mill-incident-42');

  const unsafe = await fetch(`${BASE}/health`, { headers: { 'x-request-id': 'bad id with spaces' } });
  assert.notEqual(unsafe.headers.get('x-request-id'), 'bad id with spaces');
});

test('a browser-declared cross-site write is refused before authentication', async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ email: 'owner@neelkamal.test', password: 'changeme' })
  });
  assert.equal(r.status, 403);
  const body = await r.json() as { error: string; requestId: string };
  assert.equal(body.error, 'cross-site write refused');
  assert.ok(body.requestId);
});

test('an expired token is refused', async () => {
  const secret = process.env.JWT_SECRET;
  assert.ok(secret, 'this test needs the same JWT_SECRET the server runs with');
  const expired = jwt.sign(
    { userId: 'aaaaaaaa-0000-0000-0000-000000000001', tenantId: TENANT, role: 'owner' },
    secret, { expiresIn: -60 }
  );
  const r = await api('/api/ledgers', { token: expired });
  assert.equal(r.status, 401);
});

test('a valid token naming a foreign tenant sees nothing of ours', async () => {
  const secret = process.env.JWT_SECRET;
  assert.ok(secret);
  const otherTenant = jwt.sign(
    {
      userId: 'aaaaaaaa-0000-0000-0000-000000000001',
      tenantId: '99999999-9999-9999-9999-999999999999',
      role: 'owner'
    },
    secret, { expiresIn: '1h' }
  );
  // Membership is re-read on every request now, so a token naming a company
  // the bearer does not belong to is refused rather than answered empty. Both
  // are safe; being refused is the clearer signal and the cheaper query.
  for (const path of ['/api/ledgers', '/api/pieces', '/api/sales-invoices']) {
    const r = await api(path, { token: otherTenant });
    assert.ok([401, 403].includes(r.status), `${path} answered ${r.status}`);
    assert.ok(!JSON.stringify(r.body ?? {}).includes('Prayag'),
      `${path} leaked rows across tenants`);
  }
});

test('role escalation by editing the token payload fails', async () => {
  // A viewer's own token with role rewritten to owner, signed with a guess.
  const forged = jwt.sign(
    { userId: 'aaaaaaaa-0000-0000-0000-000000000003', tenantId: TENANT, role: 'owner' },
    'guessed-secret'
  );
  const r = await api('/api/qualities', {
    method: 'POST', token: forged, body: { code: 'HACK', name: 'nope', hsn_code: '551311' }
  });
  assert.equal(r.status, 401);
});

test('SQL injection through search and identifiers is inert', async () => {
  const payloads = [
    "' or '1'='1",
    "'; drop table piece; --",
    "\\'; delete from voucher_line; --",
    '%'
  ];
  for (const p of payloads) {
    const r = await api(`/api/ledgers?q=${encodeURIComponent(p)}`);
    assert.equal(r.status, 200, `search should not error on ${p}`);
    assert.ok(Array.isArray(r.body));
  }
  // Everything must still be there.
  const after = await api('/api/ledgers');
  assert.ok(after.body.length >= 8, 'ledgers were harmed by an injection attempt');
  const pieces = await api('/api/pieces?limit=1');
  assert.equal(pieces.status, 200);
});

test('an unknown resource name cannot reach an arbitrary table', async () => {
  for (const name of ['app_user', 'voucher_line', 'pg_catalog.pg_tables', '../tenant']) {
    const r = await api(`/api/${encodeURIComponent(name)}`);
    assert.ok([404, 400].includes(r.status), `${name} answered ${r.status}`);
  }
});

test('an oversized payload is rejected rather than accepted', async () => {
  const lines = Array.from({ length: 5000 }, (_, i) => ({
    qualityId: GALAXY, gradeCode: 'LUMP', barcode: `HUGE${stamp}${i}`,
    lotNo: 'HUGE', receivedQty: 1, checkedQty: 1, rate: 1
  }));
  const r = await api('/api/grey-inwards', {
    method: 'POST', token: store,
    body: {
      partyId: WEAVER, entryDate: '2026-08-21', challanNo: `HUGE-${stamp}`,
      challanDate: '2026-08-21', lotNo: 'HUGE', lines
    }
  });
  assert.equal(r.status, 400, 'a 5000-line challan must be refused, not absorbed');
  assert.equal(r.body.error, 'validation failed');
});

// ------------------------------------------------------------ throughput --

test('a 200-piece challan is one round trip, not two hundred', async () => {
  const lines = Array.from({ length: 200 }, (_, i) => ({
    qualityId: GALAXY, gradeCode: 'LUMP', barcode: `BULK${stamp}${i}`,
    lotNo: 'BULK', receivedQty: 100, checkedQty: 100, rate: 30
  }));

  const started = Date.now();
  const r = await api('/api/grey-inwards', {
    method: 'POST', token: store,
    body: {
      partyId: WEAVER, entryDate: '2026-08-21', challanNo: `BULK-${stamp}`,
      challanDate: '2026-08-21', lotNo: 'BULK', lines
    }
  });
  const elapsed = Date.now() - started;

  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.pieces, 200);
  // A per-row implementation would take seconds; batched it is well under one.
  assert.ok(elapsed < 3000, `200 pieces took ${elapsed}ms, which smells like an N+1`);
});

test('issuing 200 pieces at once also stays batched', async () => {
  const barcodes = Array.from({ length: 200 }, (_, i) => `BULK${stamp}${i}`);
  const started = Date.now();
  const r = await api('/api/dyeing-issues', {
    method: 'POST', token: store,
    body: {
      processHouseId: PROCESS, entryDate: '2026-08-22', challanNo: `BULKPC-${stamp}`,
      challanDate: '2026-08-22', lotNo: 'BULK', jobRate: 18, barcodes
    }
  });
  const elapsed = Date.now() - started;
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.pieces, 200);
  assert.ok(elapsed < 3000, `issuing 200 pieces took ${elapsed}ms`);
});

test('the books still balance after everything above', async () => {
  const r = await api('/api/reports/trial-balance');
  const total = r.body.reduce((n: number, x: any) => n + Number(x.balance), 0);
  assert.ok(Math.abs(total) < 0.01, `trial balance drifted by ${total} under load`);
});
