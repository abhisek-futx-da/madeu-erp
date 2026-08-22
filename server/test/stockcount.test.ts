/**
 * Physical stock count and variance approval.
 *
 * Everything upstream of this is a promise. These tests hold the four things
 * that make a count worth doing: the snapshot is frozen, every difference must
 * be answered, a second person must agree, and the result reaches the movement
 * log and the ledger together — or not at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';

const PARTY_WEAVER = '33333333-0000-0000-0000-000000000105';
const PROCESS_HOUSE = '33333333-0000-0000-0000-000000000202';
const QUALITY_GALAXY = '44444444-0000-0000-0000-000000000001';
const GREY_STOCK_LEDGER = '33333333-0000-0000-0000-000000000960';
const STOCK_LOSS_LEDGER = '33333333-0000-0000-0000-000000000963';

const stamp = Date.now();
const LOT = `CNT-${stamp}`;
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

const rupees = (n: unknown) => Math.round(Number(n) * 100);

/** Three thaans on one shelf, in a lot of their own so nothing else is counted. */
async function inward(barcodes: string[], qty: number, rate: number, rack = 'A1') {
  const r = await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: PARTY_WEAVER, entryDate: '2026-08-21',
      challanNo: `CNT-${barcodes[0]}`, challanDate: '2026-08-21', lotNo: LOT,
      rackCode: rack,
      lines: barcodes.map(b => ({
        qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode: b, lotNo: LOT,
        receivedQty: qty, checkedQty: qty, rate
      }))
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

async function piece(barcode: string) {
  const r = await api(`/api/pieces?barcode=${encodeURIComponent(barcode)}&limit=1`);
  return r.body[0] ?? null;
}

async function ledgerBalance(ledgerId: string) {
  const r = await api('/api/reports/party-balance?limit=500', { as: 'owner' });
  const row = (r.body as any[]).find(x => x.ledger_id === ledgerId);
  return row ? rupees(row.balance) : 0;
}

test('sign in', async () => {
  for (const who of ['owner', 'store', 'accounts', 'viewer']) {
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

// ------------------------------------------------------------------- setup --

const A = `SC${stamp}A`;  // counted correctly
const B = `SC${stamp}B`;  // missing from the rack
const C = `SC${stamp}C`;  // present but two metres short
const D = `SC${stamp}D`;  // sitting on the wrong shelf

test('grey arrives and is put on a named shelf', async () => {
  await inward([A, B, C, D], 100, 30);   // 3000.00 each
  const p = await piece(A);
  assert.equal(p.rack_code, 'A1');
  assert.equal(rupees(p.cost), 300000);
});

// -------------------------------------------------------------------- open --

let countId = '';
let countNo = '';

test('opening a count freezes what the system believes', async () => {
  const r = await api('/api/stock-counts', {
    method: 'POST',
    body: { countDate: '2026-08-27', lotNo: LOT, reason: 'month end' }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.piecesExpected, 4);
  countId = r.body.id;
  countNo = r.body.countNo;

  const detail = await api(`/api/stock-counts/${countId}`);
  assert.equal(detail.body.sheet.length, 4);
  assert.ok(detail.body.sheet.every((s: any) => s.rack_code === 'A1' && !s.scanned));
});

test('a second count over the same stock is refused', async () => {
  const r = await api('/api/stock-counts', {
    method: 'POST', body: { countDate: '2026-08-27', lotNo: LOT, reason: 'again' }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /still open over this stock/);
});

test('a scope with nothing in it is refused rather than opened empty', async () => {
  const r = await api('/api/stock-counts', {
    method: 'POST', body: { countDate: '2026-08-27', lotNo: `NOSUCH-${stamp}`, reason: 'x' }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /nothing in stock matches/);
});

test('a viewer cannot open a count', async () => {
  const r = await api('/api/stock-counts', {
    method: 'POST', as: 'viewer',
    body: { countDate: '2026-08-27', lotNo: LOT, reason: 'x' }
  });
  assert.equal(r.status, 403);
});

// ------------------------------------------------------------------- scans --

test('the floor is scanned, mistakes included', async () => {
  const r = await api(`/api/stock-counts/${countId}/scans`, {
    method: 'POST',
    body: {
      scans: [
        { barcode: A, rackCode: 'A1', qty: 100 },
        { barcode: C, rackCode: 'A1', qty: 98 },
        { barcode: D, rackCode: 'B1', qty: 100 },
        { barcode: D, rackCode: 'B1', qty: 100 },
        { barcode: `GHOST${stamp}`, rackCode: 'A1', qty: 55 }
      ]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.recorded, 5);
});

test('every difference is named, and nothing else is', async () => {
  const r = await api(`/api/stock-counts/${countId}`);
  const found = new Map(r.body.exceptions.map((e: any) => [`${e.barcode} ${e.kind}`, e]));

  assert.ok(found.has(`${B} missing`), 'the piece nobody found is not reported');
  assert.equal(rupees((found.get(`${B} missing`) as any).value), -300000);

  const short = found.get(`${C} short`) as any;
  assert.equal(Number(short.system_qty), 100);
  assert.equal(Number(short.counted_qty), 98);
  assert.equal(rupees(short.value), -6000);   // 2 metres of a 30.00 piece

  assert.ok(found.has(`${D} wrong_rack`));
  assert.ok(found.has(`${D} duplicate_scan`));
  assert.ok(found.has(`GHOST${stamp} extra`));

  // The one that was right is not an exception.
  assert.ok(![...found.keys()].some(k => (k as string).startsWith(A)));
});

test('a mis-scan can be taken back while the sheet is open', async () => {
  const before = await api(`/api/stock-counts/${countId}`);
  const dupe = before.body.scans.find((s: any) => s.barcode === D);
  const r = await api(`/api/stock-counts/${countId}/scans/${dupe.id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);

  const after = await api(`/api/stock-counts/${countId}`);
  assert.ok(!after.body.exceptions.some((e: any) => e.kind === 'duplicate_scan'),
    'the duplicate survived its own correction');
});

// ------------------------------------------------------------------ submit --

test('a sheet with an unanswered difference cannot be submitted', async () => {
  const r = await api(`/api/stock-counts/${countId}/submit`, {
    method: 'POST',
    body: { decisions: [{ barcode: B, kind: 'missing', outcome: 'write_off', reason: 'gone' }] }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /every difference needs an answer/);
});

test('a difference cannot be answered with an outcome that makes no sense', async () => {
  const r = await api(`/api/stock-counts/${countId}/submit`, {
    method: 'POST',
    body: {
      decisions: [
        { barcode: B, kind: 'missing', outcome: 'relocate', reason: 'x' },
        { barcode: C, kind: 'short', outcome: 'adjust_qty', reason: 'x' },
        { barcode: D, kind: 'wrong_rack', outcome: 'relocate', reason: 'x' },
        { barcode: `GHOST${stamp}`, kind: 'extra', outcome: 'needs_inward', reason: 'x' }
      ]
    }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /cannot be answered with "relocate"/);
});

test('a count may not invent stock it knows nothing about', async () => {
  const r = await api(`/api/stock-counts/${countId}/submit`, {
    method: 'POST',
    body: {
      decisions: [
        { barcode: B, kind: 'missing', outcome: 'write_off', reason: 'x' },
        { barcode: C, kind: 'short', outcome: 'adjust_qty', reason: 'x' },
        { barcode: D, kind: 'wrong_rack', outcome: 'relocate', reason: 'x' },
        // `relocate` is a legal answer to an extra piece — but only when the
        // system has heard of the barcode. This one it has not.
        { barcode: `GHOST${stamp}`, kind: 'extra', outcome: 'relocate', reason: 'x' }
      ]
    }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown to the system; the only outcome is needs_inward/);
});

test('a submitted count is held for a second signature and posts nothing yet', async () => {
  const inventoryBefore = await ledgerBalance(GREY_STOCK_LEDGER);

  const r = await api(`/api/stock-counts/${countId}/submit`, {
    method: 'POST',
    body: {
      decisions: [
        { barcode: B, kind: 'missing', outcome: 'write_off', reason: 'not on the rack, not in the godown' },
        { barcode: C, kind: 'short', outcome: 'adjust_qty', reason: 'measured 98 against the tape' },
        { barcode: D, kind: 'wrong_rack', outcome: 'relocate', reason: 'moved to B1 last week' },
        { barcode: `GHOST${stamp}`, kind: 'extra', outcome: 'needs_inward', reason: 'no challan for it yet' }
      ]
    }
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'pending_approval');
  assert.equal(r.body.variances, 4);
  assert.equal(rupees(r.body.netValue), -306000);   // 3000.00 written off + 60.00 short
  assert.equal(r.body.awaiting, 'owner');

  // Nothing has moved: the whole point of holding it.
  assert.equal(await ledgerBalance(GREY_STOCK_LEDGER), inventoryBefore);
  const b = await piece(B);
  assert.equal(b.status, 'grey_in_stock');
  assert.equal(Number((await piece(C)).current_qty), 100);
});

test('a submitted sheet is frozen: its scans are now evidence', async () => {
  const detail = await api(`/api/stock-counts/${countId}`);
  const scan = detail.body.scans[0];
  const r = await api(`/api/stock-counts/${countId}/scans/${scan.id}`, { method: 'DELETE' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no longer open/);
});

test('the count is waiting in the approval queue', async () => {
  const r = await api('/api/approvals/pending', { as: 'owner' });
  const mine = (r.body as any[]).find(x => x.doc_no === countNo);
  assert.ok(mine, 'the count is not in the queue');
  assert.equal(mine.doc_type, 'stock_count');
  assert.equal(mine.approver_role, 'owner');
});

// ----------------------------------------------------------------- approve --

test('a store clerk cannot clear a count the owner must sign', async () => {
  const r = await api(`/api/approvals/stock_count/${countId}/approve`, {
    method: 'POST', as: 'store', body: { note: 'looks fine to me' }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /needs the owner role/);
});

test('even the owner cannot approve a count the owner took', async () => {
  const lot = `SELF-${stamp}`;
  const barcode = `SCS${stamp}`;
  const made = await api('/api/grey-inwards', {
    method: 'POST', as: 'owner',
    body: {
      partyId: PARTY_WEAVER, entryDate: '2026-08-21',
      challanNo: `SELF-${stamp}`, challanDate: '2026-08-21', lotNo: lot, rackCode: 'A1',
      lines: [{ qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode, lotNo: lot,
                receivedQty: 20, checkedQty: 20, rate: 30 }]
    }
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));

  const opened = await api('/api/stock-counts', {
    method: 'POST', as: 'owner',
    body: { countDate: '2026-08-27', lotNo: lot, reason: 'owner walked the rack' }
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));

  const submitted = await api(`/api/stock-counts/${opened.body.id}/submit`, {
    method: 'POST', as: 'owner',
    body: {
      decisions: [{ barcode, kind: 'missing', outcome: 'write_off', reason: 'gone' }]
    }
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

  const r = await api(`/api/approvals/stock_count/${opened.body.id}/approve`, {
    method: 'POST', as: 'owner', body: { note: 'signing my own homework' }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /raised by you/);
});

test('approval moves the stock and the rupees in one go', async () => {
  const inventoryBefore = await ledgerBalance(GREY_STOCK_LEDGER);
  const lossBefore = await ledgerBalance(STOCK_LOSS_LEDGER);

  const r = await api(`/api/approvals/stock_count/${countId}/approve`, {
    method: 'POST', as: 'owner', body: { note: 'checked the shelf myself' }
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'approved');

  // Stock: written off, shortened, and re-shelved.
  const b = await piece(B);
  assert.equal(b.status, 'written_off');
  assert.equal(Number(b.current_qty), 0);

  const c = await piece(C);
  assert.equal(Number(c.current_qty), 98);
  assert.equal(rupees(c.cost), 294000);   // 3000.00 less the 60.00 that went

  assert.equal((await piece(D)).rack_code, 'B1');
  assert.equal(Number((await piece(A)).current_qty), 100);

  // Books: inventory down by exactly what left it, the loss named on its own line.
  assert.equal(await ledgerBalance(GREY_STOCK_LEDGER), inventoryBefore - 306000);
  assert.equal(await ledgerBalance(STOCK_LOSS_LEDGER), lossBefore + 306000);
});

test('the movement log carries the correction, and the cache agrees with it', async () => {
  const h = await api(`/api/pieces/${C}/history`);
  const last = h.body.at(-1);
  assert.equal(last.doc_type, 'stock_count');
  assert.equal(Number(last.qty_after), 98);

  const drift = await api('/api/reports/piece-drift', { as: 'owner' });
  assert.deepEqual(drift.body, [], JSON.stringify(drift.body));
});

test('an approved count cannot be approved or submitted again', async () => {
  const again = await api(`/api/approvals/stock_count/${countId}/approve`, {
    method: 'POST', as: 'owner', body: { note: 'twice' }
  });
  assert.equal(again.status, 400);

  const resubmit = await api(`/api/stock-counts/${countId}/submit`, {
    method: 'POST', body: { decisions: [] }
  });
  assert.equal(resubmit.status, 400);
  assert.match(resubmit.body.error, /no longer open/);
});

test('the variance report and the owner summary say the same thing', async () => {
  const detail = await api(`/api/stock-counts/${countId}`, { as: 'owner' });
  assert.equal(detail.body.count.status, 'approved');
  assert.equal(detail.body.count.variances, 4);
  assert.equal(rupees(detail.body.count.loss_value), -306000);
  assert.equal(rupees(detail.body.count.gain_value), 0);
  assert.equal(detail.body.variances.length, 4);
  assert.ok(detail.body.variances.every((v: any) => v.reason.length > 0));

  const list = await api('/api/stock-counts?limit=50', { as: 'owner' });
  const listed = (list.body.rows as any[]).find(x => x.count_no === countNo);
  assert.ok(listed, 'the count is missing from the list');
  assert.equal(listed.count_id, countId);
});

// -------------------------------------------------------------- reversal --

test('a wrong count is cancelled and the stock comes back exactly as it was', async () => {
  const inventoryBefore = await ledgerBalance(GREY_STOCK_LEDGER);

  const r = await api(`/api/documents/stock_count/${countId}/cancel`, {
    method: 'POST', as: 'accounts', body: { reason: 'counted the wrong godown' }
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const b = await piece(B);
  assert.equal(b.status, 'grey_in_stock');
  assert.equal(Number(b.current_qty), 100);

  const c = await piece(C);
  assert.equal(Number(c.current_qty), 100);
  assert.equal(rupees(c.cost), 300000);

  assert.equal((await piece(D)).rack_code, 'A1');
  assert.equal(await ledgerBalance(GREY_STOCK_LEDGER), inventoryBefore + 306000);

  // The sheet, the scans and the variances all survive: that is the audit.
  const detail = await api(`/api/stock-counts/${countId}`, { as: 'owner' });
  assert.equal(detail.body.count.status, 'cancelled');
  assert.equal(detail.body.variances.length, 4);
  assert.equal(detail.body.scans.length, 4);
});

// ------------------------------------------------------- rejection & gains --

test('a rejected count posts nothing at all', async () => {
  const barcode = `SCR${stamp}`;
  await inward([barcode], 50, 40, 'A1');
  const lot = LOT;

  const opened = await api('/api/stock-counts', {
    method: 'POST', body: { countDate: '2026-08-28', lotNo: lot, reason: 'recount' }
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));

  const all = await api(`/api/stock-counts/${opened.body.id}`);
  // Scan everything except the new piece, so it reads as missing.
  await api(`/api/stock-counts/${opened.body.id}/scans`, {
    method: 'POST',
    body: {
      scans: all.body.sheet
        .filter((s: any) => s.barcode !== barcode)
        .map((s: any) => ({ barcode: s.barcode, rackCode: s.rack_code, qty: Number(s.qty) }))
    }
  });

  const submitted = await api(`/api/stock-counts/${opened.body.id}/submit`, {
    method: 'POST',
    body: {
      decisions: [{ barcode, kind: 'missing', outcome: 'write_off', reason: 'cannot find it' }]
    }
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

  const rejected = await api(`/api/approvals/stock_count/${opened.body.id}/reject`, {
    method: 'POST', as: 'owner', body: { reason: 'look again behind the bales' }
  });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));

  const p = await piece(barcode);
  assert.equal(p.status, 'grey_in_stock');
  assert.equal(Number(p.current_qty), 50);
});

test('finding more than the books say is a gain, not a silent correction', async () => {
  const barcode = `SCG${stamp}`;
  const lot = `GAIN-${stamp}`;
  const made = await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: PARTY_WEAVER, entryDate: '2026-08-21',
      challanNo: `GAIN-${stamp}`, challanDate: '2026-08-21', lotNo: lot, rackCode: 'A1',
      lines: [{ qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode, lotNo: lot,
                receivedQty: 100, checkedQty: 100, rate: 30 }]
    }
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));

  const opened = await api('/api/stock-counts', {
    method: 'POST', body: { countDate: '2026-08-29', lotNo: lot, reason: 'spot check' }
  });
  await api(`/api/stock-counts/${opened.body.id}/scans`, {
    method: 'POST', body: { scans: [{ barcode, rackCode: 'A1', qty: 105 }] }
  });

  const submitted = await api(`/api/stock-counts/${opened.body.id}/submit`, {
    method: 'POST',
    body: {
      decisions: [{ barcode, kind: 'excess', outcome: 'adjust_qty', reason: 'tape says 105' }]
    }
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(rupees(submitted.body.netValue), 15000);   // 5 metres at 30.00

  const approved = await api(`/api/approvals/stock_count/${opened.body.id}/approve`, {
    method: 'POST', as: 'owner', body: { note: 'agreed' }
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const p = await piece(barcode);
  assert.equal(Number(p.current_qty), 105);
  assert.equal(rupees(p.cost), 315000);
});

test('goods out at a process house are never counted as ours', async () => {
  const barcode = `SCP${stamp}`;
  const lot = `PH-${stamp}`;
  await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: PARTY_WEAVER, entryDate: '2026-08-21',
      challanNo: `PH-${stamp}`, challanDate: '2026-08-21', lotNo: lot, rackCode: 'A1',
      lines: [{ qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode, lotNo: lot,
                receivedQty: 60, checkedQty: 60, rate: 30 }]
    }
  });
  const issued = await api('/api/dyeing-issues', {
    method: 'POST',
    body: {
      processHouseId: PROCESS_HOUSE, entryDate: '2026-08-22',
      challanNo: `PC-${barcode}`, challanDate: '2026-08-22', lotNo: lot,
      jobRate: 18, barcodes: [barcode]
    }
  });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));

  const r = await api('/api/stock-counts', {
    method: 'POST', body: { countDate: '2026-08-29', lotNo: lot, reason: 'x' }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /nothing in stock matches/);
});
