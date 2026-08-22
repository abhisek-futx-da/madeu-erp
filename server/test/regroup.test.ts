/**
 * Partial rolls. A converter cuts a thaan every day, and until now the spine
 * could only move a piece whole — so the half that stayed on the rack left the
 * system and every number downstream quietly went wrong.
 *
 * These tests hold the two things that make a split trustworthy: metres are
 * conserved and rupees are conserved, to the paise, through split, merge,
 * dispatch and cancellation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apportion } from '../src/money.ts';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';

const PARTY_WEAVER = '33333333-0000-0000-0000-000000000105';
const PROCESS_HOUSE = '33333333-0000-0000-0000-000000000202';
const CUSTOMER = '33333333-0000-0000-0000-000000000701';
const QUALITY_GALAXY = '44444444-0000-0000-0000-000000000001';
const QUALITY_OTHER = '44444444-0000-0000-0000-000000000002';

const stamp = Date.now();
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

/** One barcode of grey, ready to cut. */
async function inward(barcode: string, qty: number, rate: number, qualityId = QUALITY_GALAXY) {
  const r = await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: PARTY_WEAVER,
      entryDate: '2026-08-21',
      challanNo: `SPL-${barcode}`,
      challanDate: '2026-08-21',
      lotNo: `LOT-${stamp}`,
      lines: [{
        qualityId, gradeCode: 'LUMP', barcode, lotNo: `LOT-${stamp}`,
        receivedQty: qty, checkedQty: qty, rate
      }]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id as string;
}

async function piece(barcode: string) {
  const r = await api(`/api/pieces?barcode=${encodeURIComponent(barcode)}&limit=1`);
  return r.body[0] ?? null;
}

const rupees = (n: unknown) => Math.round(Number(n) * 100);

// --------------------------------------------------------------- unit: money --

test('an amount divides across lengths without losing a paise', () => {
  // 3601.00 over three equal rolls is 1200.333... each.
  const shares = apportion(3601, [1, 1, 1]);
  assert.deepEqual(shares, [1200.34, 1200.33, 1200.33]);
  assert.equal(shares.reduce((a, b) => a + b, 0).toFixed(2), '3601.00');
});

test('a lopsided cut still adds back up', () => {
  const shares = apportion(3599, [40, 40, 38]);
  assert.equal(shares.reduce((a, b) => a + b, 0).toFixed(2), '3599.00');
  assert.ok(shares.every(s => s > 0));
});

test('apportioning across nothing is refused rather than dividing by zero', () => {
  assert.throws(() => apportion(100, [0, 0]), /zero weight/);
});

// -------------------------------------------------------------------- setup --

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

// -------------------------------------------------------------------- split --

const SPLIT = `SPL${stamp}A`;

test('a thaan splits into pieces that carry its metres and its cost exactly', async () => {
  await inward(SPLIT, 118, 30.5); // 3599.00

  const before = await piece(SPLIT);
  assert.equal(rupees(before.cost), 359900);

  const r = await api(`/api/pieces/${SPLIT}/split`, {
    method: 'POST',
    body: {
      entryDate: '2026-08-22',
      reason: 'cut for a 40 metre order',
      children: [{ qty: 40 }, { qty: 40 }, { qty: 38 }]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.kind, 'split');
  assert.deepEqual(
    r.body.pieces.map((p: any) => p.barcode),
    [`${SPLIT}-1`, `${SPLIT}-2`, `${SPLIT}-3`]
  );

  const children = await Promise.all(
    r.body.pieces.map((p: any) => piece(p.barcode))
  );
  assert.deepEqual(children.map(c => Number(c.current_qty)), [40, 40, 38]);
  assert.ok(children.every(c => c.status === 'grey_in_stock'));

  // Rupees in equal rupees out — the whole point of the exercise.
  assert.equal(children.reduce((sum, c) => sum + rupees(c.cost), 0), 359900);

  const parent = await piece(SPLIT);
  assert.equal(parent.status, 'consumed');
  assert.equal(Number(parent.current_qty), 0);
  assert.equal(rupees(parent.cost), 0);
});

test('a consumed barcode has left stock, and its children have replaced it', async () => {
  const inStock = await api('/api/pieces?status=grey_in_stock&limit=500');
  const names = inStock.body.map((p: any) => p.barcode);
  assert.ok(!names.includes(SPLIT), 'the parent is still being counted as stock');
  assert.ok(names.includes(`${SPLIT}-1`));
});

test('the lineage says which barcode became which', async () => {
  const r = await api(`/api/pieces/${SPLIT}/lineage`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 3);
  assert.ok(r.body.every((l: any) => l.from_barcode === SPLIT && l.kind === 'split'));
  assert.equal(
    r.body.reduce((sum: number, l: any) => sum + Number(l.qty), 0), 118
  );

  // Readable from the child's end too: the operator scans the short piece.
  const child = await api(`/api/pieces/${SPLIT}-3/lineage`);
  assert.equal(child.body.length, 1);
  assert.equal(child.body[0].from_barcode, SPLIT);
});

test('every regroup conserves its metres', async () => {
  const r = await api('/api/reports/regroup-imbalance');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, [], JSON.stringify(r.body));
});

// ------------------------------------------------------------ split refusals --

test('a split whose pieces do not add up is refused', async () => {
  const b = `SPL${stamp}B`;
  await inward(b, 100, 30);
  const r = await api(`/api/pieces/${b}/split`, {
    method: 'POST',
    body: { entryDate: '2026-08-22', reason: 'short', children: [{ qty: 60 }, { qty: 39 }] }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /add up to 99 MTR but .* holds 100/);
});

test('a single-piece "split" is refused: that is a rename, not a cut', async () => {
  const r = await api(`/api/pieces/${SPLIT}-1/split`, {
    method: 'POST',
    body: { entryDate: '2026-08-22', reason: 'x', children: [{ qty: 40 }] }
  });
  assert.equal(r.status, 400);
});

test('goods lying at a process house are not ours to cut', async () => {
  const b = `SPL${stamp}C`;
  await inward(b, 100, 30);
  const issue = await api('/api/dyeing-issues', {
    method: 'POST',
    body: {
      processHouseId: PROCESS_HOUSE, entryDate: '2026-08-22',
      challanNo: `PC-${b}`, challanDate: '2026-08-22', lotNo: `LOT-${stamp}`,
      jobRate: 18, barcodes: [b]
    }
  });
  assert.equal(issue.status, 201, JSON.stringify(issue.body));

  const r = await api(`/api/pieces/${b}/split`, {
    method: 'POST',
    body: { entryDate: '2026-08-22', reason: 'x', children: [{ qty: 60 }, { qty: 40 }] }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /our own custody/);
});

test('a barcode already on the floor cannot be reused for a child', async () => {
  const b = `SPL${stamp}D`;
  await inward(b, 100, 30);
  const r = await api(`/api/pieces/${b}/split`, {
    method: 'POST',
    body: {
      entryDate: '2026-08-22', reason: 'x',
      children: [{ barcode: `${SPLIT}-1`, qty: 60 }, { qty: 40 }]
    }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already in use/);
});

test('an unknown barcode is a 400, not a crash', async () => {
  const r = await api('/api/pieces/NOSUCHBARCODE/split', {
    method: 'POST',
    body: { entryDate: '2026-08-22', reason: 'x', children: [{ qty: 1 }, { qty: 1 }] }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown barcode/);
});

test('a viewer cannot cut stock', async () => {
  const r = await api(`/api/pieces/${SPLIT}-2/split`, {
    method: 'POST', as: 'viewer',
    body: { entryDate: '2026-08-22', reason: 'x', children: [{ qty: 20 }, { qty: 20 }] }
  });
  assert.equal(r.status, 403);
});

// -------------------------------------------------------------------- merge --

const MERGED = `MRG${stamp}`;

test('short ends of one lot merge back into a single piece', async () => {
  const before = await Promise.all([piece(`${SPLIT}-2`), piece(`${SPLIT}-3`)]);
  const cost = before.reduce((sum, p) => sum + rupees(p.cost), 0);

  const r = await api('/api/pieces/merge', {
    method: 'POST',
    body: {
      barcodes: [`${SPLIT}-2`, `${SPLIT}-3`],
      intoBarcode: MERGED,
      entryDate: '2026-08-23',
      reason: 're-lotting short ends'
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  const merged = await piece(MERGED);
  assert.equal(Number(merged.current_qty), 78);
  assert.equal(rupees(merged.cost), cost);
  assert.equal(merged.status, 'grey_in_stock');

  for (const p of before) {
    const after = await piece(p.barcode);
    assert.equal(after.status, 'consumed');
    assert.equal(rupees(after.cost), 0);
  }
});

test('pieces of different qualities cannot become one roll', async () => {
  const a = `MIX${stamp}A`;
  const b = `MIX${stamp}B`;
  await inward(a, 50, 30);
  await inward(b, 50, 30, QUALITY_OTHER);

  const r = await api('/api/pieces/merge', {
    method: 'POST',
    body: { barcodes: [a, b], intoBarcode: `MIX${stamp}Z`, entryDate: '2026-08-23', reason: 'x' }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /same quality/);
});

test('a merge of one piece is refused', async () => {
  const r = await api('/api/pieces/merge', {
    method: 'POST',
    body: { barcodes: [MERGED], intoBarcode: `X${stamp}`, entryDate: '2026-08-23', reason: 'x' }
  });
  assert.equal(r.status, 400);
});

// ------------------------------------------------- a cut roll sells normally --

test('a piece cut from a thaan goes through dyeing, dispatch and invoice', async () => {
  const b = `${SPLIT}-1`;

  const issue = await api('/api/dyeing-issues', {
    method: 'POST',
    body: {
      processHouseId: PROCESS_HOUSE, entryDate: '2026-08-23',
      challanNo: `PC-${b}`, challanDate: '2026-08-23', lotNo: `LOT-${stamp}`,
      jobRate: 18, barcodes: [b]
    }
  });
  assert.equal(issue.status, 201, JSON.stringify(issue.body));

  const receipt = await api('/api/dyeing-receipts', {
    method: 'POST',
    body: {
      processHouseId: PROCESS_HOUSE, entryDate: '2026-09-05',
      challanNo: `PR-${b}`, challanDate: '2026-09-05',
      lines: [{ barcode: b, receivedQty: 38, finishGrade: 'A', jobRate: 18 }]
    }
  });
  assert.equal(receipt.status, 201, JSON.stringify(receipt.body));

  const packed = await api('/api/cut-pack', {
    method: 'POST', body: { barcodes: [b], note: 'split roll' }
  });
  assert.equal(packed.status, 201, JSON.stringify(packed.body));

  const dispatch = await api('/api/dispatches', {
    method: 'POST', as: 'owner',
    body: {
      partyId: CUSTOMER, challanNo: `DC-${b}`, challanDate: '2026-09-10',
      lines: [{ barcode: b, rate: 80 }]
    }
  });
  assert.equal(dispatch.status, 201, JSON.stringify(dispatch.body));

  const invoice = await api('/api/sales-invoices', {
    method: 'POST', as: 'owner',
    body: { dispatchId: dispatch.body.id, invoiceDate: '2026-09-10' }
  });
  assert.equal(invoice.status, 201, JSON.stringify(invoice.body));
  assert.equal(rupees(invoice.body.taxableValue), 38 * 80 * 100);
});

// ------------------------------------------------------------- cancellation --

test('a mis-keyed split is cancelled and the thaan comes back whole', async () => {
  const b = `UND${stamp}`;
  await inward(b, 90, 40); // 3600.00

  const split = await api(`/api/pieces/${b}/split`, {
    method: 'POST',
    body: { entryDate: '2026-08-24', reason: 'fat fingers', children: [{ qty: 30 }, { qty: 60 }] }
  });
  assert.equal(split.status, 201, JSON.stringify(split.body));

  const cancel = await api(`/api/documents/piece_regroup/${split.body.id}/cancel`, {
    method: 'POST', as: 'accounts', body: { reason: 'wrong lengths keyed' }
  });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  assert.equal(cancel.body.revertedPieces, 3);

  const parent = await piece(b);
  assert.equal(parent.status, 'grey_in_stock');
  assert.equal(Number(parent.current_qty), 90);
  assert.equal(rupees(parent.cost), 360000);

  for (const child of split.body.pieces) {
    const after = await piece(child.barcode);
    assert.equal(after.status, 'consumed');
    assert.equal(rupees(after.cost), 0);
  }
});

test('re-cutting a thaan continues the numbering past the cancelled attempt', async () => {
  const b = `AGN${stamp}`;
  await inward(b, 90, 40);

  const first = await api(`/api/pieces/${b}/split`, {
    method: 'POST',
    body: { entryDate: '2026-08-24', reason: 'wrong', children: [{ qty: 30 }, { qty: 60 }] }
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  await api(`/api/documents/piece_regroup/${first.body.id}/cancel`, {
    method: 'POST', as: 'accounts', body: { reason: 'wrong lengths' }
  });

  // -1 and -2 still exist as consumed pieces; a barcode is never reused.
  const again = await api(`/api/pieces/${b}/split`, {
    method: 'POST',
    body: { entryDate: '2026-08-24', reason: 'right this time', children: [{ qty: 45 }, { qty: 45 }] }
  });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.deepEqual(
    again.body.pieces.map((p: any) => p.barcode), [`${b}-3`, `${b}-4`]
  );
});

test('a split cannot be cancelled once a child has moved on', async () => {
  const b = `MVD${stamp}`;
  await inward(b, 90, 40);

  const split = await api(`/api/pieces/${b}/split`, {
    method: 'POST',
    body: { entryDate: '2026-08-24', reason: 'genuine cut', children: [{ qty: 30 }, { qty: 60 }] }
  });
  assert.equal(split.status, 201, JSON.stringify(split.body));

  const issue = await api('/api/dyeing-issues', {
    method: 'POST',
    body: {
      processHouseId: PROCESS_HOUSE, entryDate: '2026-08-25',
      challanNo: `PC-${b}`, challanDate: '2026-08-25', lotNo: `LOT-${stamp}`,
      jobRate: 18, barcodes: [`${b}-1`]
    }
  });
  assert.equal(issue.status, 201, JSON.stringify(issue.body));

  const cancel = await api(`/api/documents/piece_regroup/${split.body.id}/cancel`, {
    method: 'POST', as: 'accounts', body: { reason: 'too late' }
  });
  assert.equal(cancel.status, 400);
  assert.match(cancel.body.error, /moved on since/);
});

// -------------------------------------------------------------- concurrency --

test('two clerks cutting the same thaan at once produce one cut, not two', async () => {
  const b = `RACE${stamp}`;
  await inward(b, 100, 30); // 3000.00

  const cut = (n: number) => api(`/api/pieces/${b}/split`, {
    method: 'POST',
    body: {
      entryDate: '2026-08-26', reason: `clerk ${n}`,
      children: [{ barcode: `${b}-C${n}A`, qty: 60 }, { barcode: `${b}-C${n}B`, qty: 40 }]
    }
  });

  const [a, c] = await Promise.all([cut(1), cut(2)]);
  const codes = [a.status, c.status].sort();
  assert.deepEqual(codes, [201, 400], `${a.status}/${c.status}: ${JSON.stringify([a.body, c.body])}`);

  // The loser must not have left stock behind: 100 metres in, 100 metres out.
  const live = await api(`/api/pieces?status=grey_in_stock&limit=500`);
  const mine = live.body.filter((p: any) => p.barcode.startsWith(`${b}-`));
  assert.equal(mine.length, 2);
  assert.equal(mine.reduce((sum: number, p: any) => sum + Number(p.current_qty), 0), 100);
  assert.equal(mine.reduce((sum: number, p: any) => sum + rupees(p.cost), 0), 300000);
});

// --------------------------------------------------------------- the ledger --

test('the movement log is still the only truth about every cut piece', async () => {
  const drift = await api('/api/reports/piece-drift');
  assert.equal(drift.status, 200);
  assert.deepEqual(drift.body, [], JSON.stringify(drift.body));

  const imbalance = await api('/api/reports/regroup-imbalance');
  assert.deepEqual(imbalance.body, [], JSON.stringify(imbalance.body));
});

test('regroups are listed, searchable and exportable like every other document', async () => {
  const r = await api('/api/piece-regroups?limit=100');
  assert.equal(r.status, 200);
  assert.ok(r.body.total >= 4, `only ${r.body.total} regroups listed`);
  assert.ok(r.body.rows.every((row: any) => Number(row.pieces) > 0));

  const csv = await fetch(`${BASE}/api/piece-regroups?format=csv`, {
    headers: { authorization: `Bearer ${tokens.store}` }
  });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
});
test('a split with cutting loss is accepted and posts a loss voucher', async () => {
  const r1 = await api('/api/pieces', { as: 'store' });
  const pieces = r1.body;
  const parent = pieces.find((p: any) => p.status === 'grey_in_stock' && Number(p.current_qty) > 10);
  assert.ok(parent, 'need a piece to split');

  const split = await api('/api/pieces/' + parent.barcode + '/split', {
    method: 'POST', as: 'store',
    body: {
      entryDate: '2024-03-25',
      reason: 'cutting loss test',
      lossQty: 2,
      children: [{ qty: Number(parent.current_qty) - 2 }]
    }
  });

  assert.equal(split.status, 201, JSON.stringify(split.body));
  assert.equal(split.body.lossQty, 2);
  assert.ok(split.body.lossCost > 0);
});

test('cancelling a split with loss brings back the full cost to the parent piece', async () => {
  const p1 = (await api('/api/pieces', { as: 'store' })).body.find((p: any) => p.status === 'grey_in_stock' && p.current_qty > 10);
  assert.ok(p1, 'need piece');

  const originalCost = Number(p1.cost);

  const split = await api('/api/pieces/' + p1.barcode + '/split', {
    method: 'POST', as: 'store',
    body: { entryDate: '2024-03-25', reason: 'cancel loss test', lossQty: 2, children: [{ qty: Number(p1.current_qty) - 2 }] }
  });

  const p2 = (await api('/api/pieces', { as: 'store' })).body.find((p: any) => p.barcode === p1.barcode);
  assert.ok(Number(p2.cost) === 0, 'Cost zeroed');

  const cancelRes = await api('/api/documents/piece_regroup/' + split.body.id + '/cancel', {
    method: 'POST', as: 'owner', body: { reason: 'undo' }
  });

  const p3 = (await api('/api/pieces', { as: 'store' })).body.find((p: any) => p.barcode === p1.barcode);
  const restoredCost = Number(p3.cost);

  assert.equal(restoredCost, originalCost, 'cost should be fully restored');
});
