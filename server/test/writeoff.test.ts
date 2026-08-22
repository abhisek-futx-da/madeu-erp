import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const tokens: Record<string, string> = {};

async function api(
  path: string,
  opts: { method?: string; body?: unknown; as?: string } = {}
) {
  const token = tokens[opts.as ?? 'store'] ?? '';
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

const PARTY_WEAVER = '33333333-0000-0000-0000-000000000105';
const QUALITY_GALAXY = '44444444-0000-0000-0000-000000000001';
const stamp = Date.now();

test('sign in', async () => {
  for (const who of ['owner', 'store', 'accounts']) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${who}@neelkamal.test`, password: 'changeme' })
    });
    const body = await r.json() as { token: string };
    assert.equal(r.status, 200, JSON.stringify(body));
    tokens[who] = body.token;
  }
});

test('pieces can be written off through maker-checker', async () => {
  const bc = `WO${stamp}`;

  // 1. Create a grey piece
  const inw = await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: PARTY_WEAVER, entryDate: '2026-08-21',
      challanNo: `CH-WO-${stamp}`, challanDate: '2026-08-21', lotNo: `LT-WO-${stamp}`,
      rackCode: 'A1',
      lines: [{
        qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode: bc, lotNo: `LT-WO-${stamp}`,
        receivedQty: 100, checkedQty: 100, rate: 10
      }]
    }
  });
  assert.equal(inw.status, 201, 'inward failed: ' + JSON.stringify(inw.body));

  // 2. Find the piece
  const eligible = await api(`/api/pieces?barcode=${bc}`);
  const piece = eligible.body[0];
  assert.ok(piece, 'piece must exist after inward');

  // 3. Post write-off
  const w = await api('/api/write-offs', {
    method: 'POST',
    body: {
      entryDate: '2026-09-01',
      reason: 'Water damage',
      // The server derives the loss from the piece's recorded cost.  The
      // caller is deliberately not allowed to decide the accounting value.
      lines: [{ barcode: piece.barcode }]
    }
  });
  assert.equal(w.status, 201, 'posted write off: ' + JSON.stringify(w.body));
  assert.equal(Number(w.body.value), Number(piece.cost));

  // 4. Check pending approval
  const p = await api('/api/approvals/pending');
  const pending = p.body.find((x: any) => x.doc_type === 'write_off' && x.doc_id === w.body.writeOffId);
  assert.ok(pending, 'write-off is waiting for approval');

  // 5. Approve (as owner, a different user from the maker)
  const app = await api(`/api/approvals/write_off/${w.body.writeOffId}/approve`, {
    method: 'POST',
    as: 'owner',
    body: {}
  });
  assert.equal(app.status, 200, 'approved: ' + JSON.stringify(app.body));

  // 6. Verify piece is now written_off
  const after = await api(`/api/pieces?barcode=${bc}`);
  assert.equal(after.body[0]?.status, 'written_off', 'piece status is written_off');
});
