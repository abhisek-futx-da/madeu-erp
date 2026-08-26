/**
 * The trade details the incumbent has: bale numbers, the customer's own name
 * for our cloth, the missing-barcode question at the loading bay, a piece's
 * journey beside the document, and a re-measure of one thaan.
 *
 * The last one carries the weight. A quick re-measure is exactly how a
 * traceability spine acquires a back door, so the test that matters is the one
 * proving it does not: nothing moves until a second person approves it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';

const PARTY_WEAVER = '33333333-0000-0000-0000-000000000105';
const PROCESS_HOUSE = '33333333-0000-0000-0000-000000000202';
const CUSTOMER = '33333333-0000-0000-0000-000000000701';
const QUALITY_GALAXY = '44444444-0000-0000-0000-000000000001';

const stamp = Date.now();
const tokens: Record<string, string> = {};

async function api(
  path: string,
  opts: { method?: string; body?: unknown; as?: string } = {}
) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(tokens[opts.as ?? 'store'] ? { authorization: `Bearer ${tokens[opts.as ?? 'store']}` } : {})
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

const piece = async (barcode: string) =>
  (await api(`/api/pieces?barcode=${encodeURIComponent(barcode)}&limit=1`)).body[0] ?? null;

/** Grey in, dyed, back, packed — a thaan ready to load onto a lorry. */
async function readyToShip(tag: string, qtyMtr = 100) {
  const barcode = `TD${stamp}${tag}`;
  const lot = `TD-${stamp}`;
  const made = await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: PARTY_WEAVER, entryDate: '2026-08-21',
      challanNo: `TDIN-${tag}${stamp}`, challanDate: '2026-08-21', lotNo: lot, rackCode: 'A1',
      lines: [{ qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode, lotNo: lot,
                receivedQty: qtyMtr, checkedQty: qtyMtr, rate: 30 }]
    }
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));

  const issue = await api('/api/dyeing-issues', {
    method: 'POST',
    body: {
      processHouseId: PROCESS_HOUSE, entryDate: '2026-08-22',
      challanNo: `TDPC-${tag}${stamp}`, challanDate: '2026-08-22', lotNo: lot,
      jobRate: 18, barcodes: [barcode]
    }
  });
  assert.equal(issue.status, 201, JSON.stringify(issue.body));

  const receipt = await api('/api/dyeing-receipts', {
    method: 'POST',
    body: {
      processHouseId: PROCESS_HOUSE, entryDate: '2026-09-05',
      challanNo: `TDPR-${tag}${stamp}`, challanDate: '2026-09-05',
      lines: [{ barcode, receivedQty: qtyMtr - 4, finishGrade: 'A', jobRate: 18 }]
    }
  });
  assert.equal(receipt.status, 201, JSON.stringify(receipt.body));

  const packed = await api('/api/cut-pack', {
    method: 'POST', body: { barcodes: [barcode], note: 'trade depth' }
  });
  assert.equal(packed.status, 201, JSON.stringify(packed.body));
  return { barcode, issueId: issue.body.id as string };
}

test('sign in', async () => {
  for (const who of ['owner', 'store', 'accounts']) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${who}@neelkamal.test`, password: 'changeme' })
    });
    const body = await r.json() as { token: string };
    assert.equal(r.status, 200, JSON.stringify(body));
    tokens[who] = body.token;
  }
});

// --------------------------------------------- the customer's own words --

test('a customer\'s own name for our cloth is recorded and read back', async () => {
  const r = await api('/api/party-aliases', {
    method: 'POST', as: 'owner',
    body: {
      partyId: CUSTOMER, qualityId: QUALITY_GALAXY,
      theirQuality: 'SUPREME COTTON 58"', notes: 'their catalogue name'
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  const list = await api(`/api/party-aliases?partyId=${CUSTOMER}`, { as: 'owner' });
  const mine = (list.body as any[]).find(a => a.their_quality === 'SUPREME COTTON 58"');
  assert.ok(mine, 'the alias was not stored');
  assert.equal(mine.quality, 'Galaxy');
});

test('asking twice updates the answer rather than making two', async () => {
  await api('/api/party-aliases', {
    method: 'POST', as: 'owner',
    body: { partyId: CUSTOMER, qualityId: QUALITY_GALAXY, theirQuality: 'SUPREME COTTON 60"' }
  });
  const list = await api(`/api/party-aliases?partyId=${CUSTOMER}`, { as: 'owner' });
  const forGalaxy = (list.body as any[])
    .filter(a => a.quality === 'Galaxy' && a.design === null);
  assert.equal(forGalaxy.length, 1, 'a second alias was created for the same scope');
  assert.equal(forGalaxy[0].their_quality, 'SUPREME COTTON 60"');
});

test('an alias that says nothing is refused', async () => {
  const r = await api('/api/party-aliases', {
    method: 'POST', as: 'owner',
    body: { partyId: CUSTOMER, qualityId: QUALITY_GALAXY, theirQuality: '  ', theirDesign: '' }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /customer's name/);
});

test('a storekeeper cannot rename a customer\'s cloth', async () => {
  const r = await api('/api/party-aliases', {
    method: 'POST', as: 'store',
    body: { partyId: CUSTOMER, qualityId: QUALITY_GALAXY, theirQuality: 'nope' }
  });
  assert.equal(r.status, 403);
});

// ------------------------------------------------------------- bales --

let dispatchId = '';

test('a dispatch remembers which bale each thaan went into', async () => {
  const a = await readyToShip('A');
  const b = await readyToShip('B');
  const c = await readyToShip('C');

  const r = await api('/api/dispatches', {
    method: 'POST', as: 'owner',
    body: {
      partyId: CUSTOMER, challanNo: `TDDC-${stamp}`, challanDate: '2026-09-10',
      lines: [
        { barcode: a.barcode, rate: 80, baleNo: 1 },
        { barcode: b.barcode, rate: 80, baleNo: 1 },
        { barcode: c.barcode, rate: 80, baleNo: 2 }
      ]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  dispatchId = r.body.id;

  const bales = await api(`/api/dispatches/${dispatchId}/bales`, { as: 'owner' });
  assert.equal(bales.status, 200);
  assert.deepEqual((bales.body as any[]).map(x => Number(x.bale_no)), [1, 2]);
  assert.equal(Number((bales.body as any[])[0].pieces), 2);
  assert.equal(Number((bales.body as any[])[1].pieces), 1);
  assert.match((bales.body as any[])[0].barcodes, /TD/);
});

test('the packing list prints the bale and the customer\'s own name', async () => {
  const r = await api(`/api/dispatches/${dispatchId}/packing-list`, { as: 'owner' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const line = r.body.lines[0];
  assert.ok(line.bale_no, 'no bale number on the packing list');
  assert.equal(line.their_quality, 'SUPREME COTTON 60"');
  // Our own name is still there for our own people.
  assert.equal(line.quality, 'Galaxy');
});

test('a bale number outside the sane range is refused', async () => {
  const d = await readyToShip('D');
  const r = await api('/api/dispatches', {
    method: 'POST', as: 'owner',
    body: {
      partyId: CUSTOMER, challanNo: `TDBAD-${stamp}`, challanDate: '2026-09-10',
      lines: [{ barcode: d.barcode, rate: 80, baleNo: 99999 }]
    }
  });
  assert.equal(r.status, 400);
});

// ------------------------------------------------- the loading-bay question --

test('a half-scanned challan says exactly which thaans are missing', async () => {
  const lot = `MISS-${stamp}`;
  const codes = ['M1', 'M2', 'M3'].map(t => `TDM${stamp}${t}`);
  await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: PARTY_WEAVER, entryDate: '2026-08-21',
      challanNo: `MISSIN-${stamp}`, challanDate: '2026-08-21', lotNo: lot, rackCode: 'A1',
      lines: codes.map(b => ({ qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode: b,
                               lotNo: lot, receivedQty: 100, checkedQty: 100, rate: 30 }))
    }
  });
  const issue = await api('/api/dyeing-issues', {
    method: 'POST',
    body: {
      processHouseId: PROCESS_HOUSE, entryDate: '2026-08-22',
      challanNo: `MISSPC-${stamp}`, challanDate: '2026-08-22', lotNo: lot,
      jobRate: 18, barcodes: codes
    }
  });
  assert.equal(issue.status, 201, JSON.stringify(issue.body));

  const partial = await api(`/api/documents/dyeing_issue/${issue.body.id}/missing`, {
    method: 'POST', body: { scanned: [codes[0]!, codes[1]!] }
  });
  assert.equal(partial.status, 200, JSON.stringify(partial.body));
  assert.equal(partial.body.expected, 3);
  assert.equal(partial.body.scanned, 2);
  assert.equal(partial.body.complete, false);
  assert.deepEqual(partial.body.missing.map((m: any) => m.barcode), [codes[2]]);

  const full = await api(`/api/documents/dyeing_issue/${issue.body.id}/missing`, {
    method: 'POST', body: { scanned: codes }
  });
  assert.equal(full.body.complete, true);
  assert.deepEqual(full.body.missing, []);
});

test('a barcode that does not belong on the challan is called out too', async () => {
  const lot = `EXTRA-${stamp}`;
  const barcode = `TDX${stamp}`;
  await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: PARTY_WEAVER, entryDate: '2026-08-21',
      challanNo: `EXTRAIN-${stamp}`, challanDate: '2026-08-21', lotNo: lot, rackCode: 'A1',
      lines: [{ qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode, lotNo: lot,
                receivedQty: 100, checkedQty: 100, rate: 30 }]
    }
  });
  const issue = await api('/api/dyeing-issues', {
    method: 'POST',
    body: {
      processHouseId: PROCESS_HOUSE, entryDate: '2026-08-22',
      challanNo: `EXTRAPC-${stamp}`, challanDate: '2026-08-22', lotNo: lot,
      jobRate: 18, barcodes: [barcode]
    }
  });

  const r = await api(`/api/documents/dyeing_issue/${issue.body.id}/missing`, {
    method: 'POST', body: { scanned: [barcode, 'NOT-ON-THIS-CHALLAN'] }
  });
  assert.deepEqual(r.body.unexpected, ['NOT-ON-THIS-CHALLAN']);
  assert.equal(r.body.complete, false);
});

// ------------------------------------------------------------ flow details --

test('a thaan\'s journey reads beside the document, not only in a report', async () => {
  const bales = await api(`/api/dispatches/${dispatchId}/bales`, { as: 'owner' });
  const barcode = (bales.body as any[])[0].barcodes.split(', ')[0];

  const one = await api(`/api/pieces/${barcode}/flow`, { as: 'owner' });
  assert.equal(one.status, 200);
  const events = (one.body as any[]).map(e => e.event);
  assert.ok(events.includes('inward'), 'inward missing from the journey');
  assert.ok(events.includes('dispatch'), 'dispatch missing from the journey');

  const whole = await api(`/api/documents/dispatch/${dispatchId}/flow`, { as: 'owner' });
  assert.equal(whole.status, 200);
  const seen = new Set((whole.body as any[]).map(e => e.barcode));
  assert.equal(seen.size, 3, 'the document flow did not cover every thaan');
});

test('a document type with no pieces is refused rather than answered emptily', async () => {
  const r = await api(`/api/documents/sales_invoice/${dispatchId}/flow`, { as: 'owner' });
  assert.equal(r.status, 400);
});

// -------------------------------------------------- re-measuring one thaan --

test('a floor re-measure posts nothing until a second person approves it', async () => {
  const { barcode } = await readyToShip('R', 100);
  const before = await piece(barcode);
  assert.equal(Number(before.current_qty), 96);   // 100 grey, 4 lost in dyeing

  const r = await api(`/api/pieces/${barcode}/recheck`, {
    method: 'POST',
    body: { countedQty: 94.5, reason: 'tape reads 94.5 at the rack' }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'pending_approval');
  assert.equal(r.body.systemQty, 96);
  assert.equal(r.body.countedQty, 94.5);
  assert.equal(r.body.unchanged, false);

  // Nothing has moved: that is the whole point.
  assert.equal(Number((await piece(barcode)).current_qty), 96);

  const queue = await api('/api/approvals/pending', { as: 'owner' });
  assert.ok((queue.body as any[]).some(q => q.doc_no === r.body.countNo));
});

test('once approved, the floor\'s figure wins and the value follows it', async () => {
  const { barcode } = await readyToShip('S', 100);
  const r = await api(`/api/pieces/${barcode}/recheck`, {
    method: 'POST', body: { countedQty: 90, reason: 'measured short' }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  const approved = await api(`/api/approvals/stock_count/${r.body.id}/approve`, {
    method: 'POST', as: 'owner', body: { note: 'checked it myself' }
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const after = await piece(barcode);
  assert.equal(Number(after.current_qty), 90);
});

test('a re-measure that agrees with the books is recorded and changes nothing', async () => {
  const { barcode } = await readyToShip('T', 100);
  const r = await api(`/api/pieces/${barcode}/recheck`, {
    method: 'POST', body: { countedQty: 96, reason: 'spot check, agrees' }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.unchanged, true);
  assert.equal(r.body.variances, 0);
  assert.equal(Number(r.body.netValue), 0);
});

test('a re-measure needs a reason, and cannot touch goods at a process house', async () => {
  const { barcode } = await readyToShip('U', 100);
  const noReason = await api(`/api/pieces/${barcode}/recheck`, {
    method: 'POST', body: { countedQty: 90, reason: '   ' }
  });
  assert.equal(noReason.status, 400);

  const lot = `PH-RC-${stamp}`;
  const out = `TDPH${stamp}`;
  await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: PARTY_WEAVER, entryDate: '2026-08-21',
      challanNo: `PHRCIN-${stamp}`, challanDate: '2026-08-21', lotNo: lot, rackCode: 'A1',
      lines: [{ qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode: out, lotNo: lot,
                receivedQty: 60, checkedQty: 60, rate: 30 }]
    }
  });
  await api('/api/dyeing-issues', {
    method: 'POST',
    body: {
      processHouseId: PROCESS_HOUSE, entryDate: '2026-08-22',
      challanNo: `PHRCPC-${stamp}`, challanDate: '2026-08-22', lotNo: lot,
      jobRate: 18, barcodes: [out]
    }
  });

  const atHouse = await api(`/api/pieces/${out}/recheck`, {
    method: 'POST', body: { countedQty: 55, reason: 'cannot measure what we do not hold' }
  });
  assert.equal(atHouse.status, 400);
  assert.match(atHouse.body.error, /our own custody/);
});

test('a viewer cannot re-measure stock', async () => {
  const { barcode } = await readyToShip('V', 100);
  const r = await api(`/api/pieces/${barcode}/recheck`, {
    method: 'POST', as: 'accounts',
    body: { countedQty: 90, reason: 'not my job' }
  });
  assert.equal(r.status, 403);
});

// ---------------------------------------------------------------- divisions --

test('divisions are a master, not free text', async () => {
  const made = await api('/api/divisions', {
    method: 'POST', as: 'owner',
    body: { code: `DIV${stamp}`.slice(0, 12), name: 'Shirting', sort_order: 1, is_active: true }
  });
  assert.ok([200, 201].includes(made.status), JSON.stringify(made.body));

  const list = await api('/api/divisions', { as: 'owner' });
  assert.ok((list.body.rows ?? list.body).some?.((d: any) => d.name === 'Shirting')
    || JSON.stringify(list.body).includes('Shirting'));
});
