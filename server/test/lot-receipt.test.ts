/**
 * Receiving from a process house that cannot return the barcodes it was sent.
 *
 * Thaans go out, get stitched end to end into one batch for the jet, and come
 * back cut into different finished lengths with the paper labels long gone.
 * The piece-wise receipt cannot express that at all. These tests hold the lot
 * path: quantities agreed against the issue, new barcodes at the inspection
 * table, and every rupee of cost following the cloth.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const WEAVER = '33333333-0000-0000-0000-000000000105';
const PROCESS = '33333333-0000-0000-0000-000000000202';
const GALAXY = '44444444-0000-0000-0000-000000000001';
const FINISH_STOCK = '33333333-0000-0000-0000-000000000961';

const stamp = Date.now();
let token = '';
let issueId = '';
let sentBarcodes: string[] = [];

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

const paise = (n: unknown) => Math.round(Number(n ?? 0) * 100);

async function balance(ledgerId: string) {
  const r = await api('/api/reports/party-balance?limit=1000');
  const row = (r.body as any[]).find(x => x.ledger_id === ledgerId);
  return row ? paise(row.balance) : 0;
}

async function piece(barcode: string) {
  const r = await api(`/api/pieces?barcode=${encodeURIComponent(barcode)}&limit=5`);
  const rows = Array.isArray(r.body) ? r.body : r.body.rows;
  return rows.find((p: any) => p.barcode === barcode);
}

test('sign in', async () => {
  const r = await api('/api/auth/login', {
    method: 'POST', body: { email: 'owner@neelkamal.test', password: 'changeme' }
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  token = r.body.token;
});

test('four thaans go out to the process house', async () => {
  sentBarcodes = [0, 1, 2, 3].map(i => `LOT${stamp}${i}`);

  const inward = await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: WEAVER, entryDate: '2026-08-21',
      challanNo: `LOTCH-${stamp}`, challanDate: '2026-08-21', lotNo: `LOT-${stamp}`,
      lines: sentBarcodes.map(b => ({
        qualityId: GALAXY, gradeCode: 'LUMP', barcode: b, lotNo: `LOT-${stamp}`,
        receivedQty: 250, checkedQty: 250, rate: 30
      }))
    }
  });
  assert.equal(inward.status, 201, JSON.stringify(inward.body));

  const issue = await api('/api/dyeing-issues', {
    method: 'POST',
    body: {
      processHouseId: PROCESS, entryDate: '2026-08-22',
      challanNo: `LOTPC-${stamp}`, challanDate: '2026-08-22',
      lotNo: `LOT-${stamp}`, jobRate: 20, barcodes: sentBarcodes
    }
  });
  assert.equal(issue.status, 201, JSON.stringify(issue.body));
  issueId = issue.body.id;
});

test('the issue shows as still out, so a receipt can name it', async () => {
  const r = await api(`/api/dyeing-issues/outstanding?processHouseId=${PROCESS}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const mine = (r.body as any[]).find(x => x.issue_id === issueId);
  assert.ok(mine, 'the issue is missing from what is out at the process house');
  assert.equal(mine.thaans, 4);
  assert.equal(Number(mine.issued_qty), 1000);
});

test('three different thaans come back, and the lot reconciles', async () => {
  const finishBefore = await balance(FINISH_STOCK);

  // 1,000 mtr went out; 970 comes back as three lengths that never existed
  // before. 3% shrinkage, inside the policy.
  const r = await api('/api/dyeing-receipts/by-lot', {
    method: 'POST',
    body: {
      issueId, entryDate: '2026-09-05',
      challanNo: `LOTPR-${stamp}`, challanDate: '2026-09-05',
      jobRate: 20,
      pieces: [
        { barcode: `FIN${stamp}A`, qty: 400, finishGrade: 'A' },
        { barcode: `FIN${stamp}B`, qty: 350, finishGrade: 'A' },
        { barcode: `FIN${stamp}C`, qty: 220, finishGrade: 'B' }
      ]
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  assert.equal(r.body.mode, 'lot');
  assert.equal(r.body.thaansSent, 4);
  assert.equal(r.body.thaansReturned, 3);
  assert.equal(Number(r.body.issuedQty), 1000);
  assert.equal(Number(r.body.receivedQty), 970);
  assert.equal(Number(r.body.shrinkageQty), 30);
  assert.equal(Number(r.body.shrinkagePct), 3);

  // Job work is charged on what came back, at the agreed rate: 970 x 20.
  assert.equal(Number(r.body.jobworkValue), 19400);

  // Grey cost 1,000 x 30 = 30,000, plus 19,400 job work, lands in finish stock.
  assert.equal(await balance(FINISH_STOCK) - finishBefore, 4940000);
});

test('the thaans that went out no longer name goods, and the new ones do', async () => {
  for (const barcode of sentBarcodes) {
    const p = await piece(barcode);
    assert.ok(p, `${barcode} vanished instead of being consumed`);
    assert.equal(p.status, 'consumed',
      `${barcode} still claims to be real cloth after the batch was cut up`);
  }

  const a = await piece(`FIN${stamp}A`);
  assert.equal(a.status, 'received_finish');
  assert.equal(Number(a.current_qty), 400);
});

test('every rupee that went out came back, split by length', async () => {
  // 30,000 grey + 19,400 job work across three pieces, apportioned 400/350/220.
  const pieces = await Promise.all(
    ['A', 'B', 'C'].map(suffix => piece(`FIN${stamp}${suffix}`))
  );
  const total = pieces.reduce((n, p) => n + paise(p.cost), 0);
  assert.equal(total, 4940000,
    'the cost pooled from four thaans did not arrive whole on the three that replaced them');

  // Nothing may be left behind on the parents, or the same rupees are counted
  // twice in any total taken across every piece.
  const parents = await Promise.all(sentBarcodes.map(b => piece(b)));
  assert.equal(parents.reduce((n, p) => n + paise(p.cost), 0), 0,
    'the consumed thaans still carry cost that has already moved to their children');
});

test('a thaan can be traced back through the batch to the grey it came from', async () => {
  const r = await api(`/api/reports/piece-lineage?limit=200&q=FIN${stamp}A`);
  assert.equal(r.status, 200);

  const rows = (r.body as any[]).filter(x => x.to_barcode === `FIN${stamp}A`);
  assert.equal(rows.length, 4,
    'the finished thaan should name all four thaans that were stitched into its batch');
  assert.ok(rows.every(x => sentBarcodes.includes(x.from_barcode)));
});

test('nothing can be received twice against the same issue', async () => {
  const again = await api('/api/dyeing-receipts/by-lot', {
    method: 'POST',
    body: {
      issueId, entryDate: '2026-09-06',
      challanNo: `LOTPR2-${stamp}`, challanDate: '2026-09-06', jobRate: 20,
      pieces: [{ barcode: `FIN${stamp}D`, qty: 100, finishGrade: 'A' }]
    }
  });
  assert.equal(again.status, 400, JSON.stringify(again.body));
  assert.match(again.body.error, /nothing is still out/);
});

test('a lot that lost more than the agreed limit is refused', async () => {
  const barcodes = [`BAD${stamp}0`, `BAD${stamp}1`];
  await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: WEAVER, entryDate: '2026-08-21',
      challanNo: `BADCH-${stamp}`, challanDate: '2026-08-21', lotNo: `BAD-${stamp}`,
      lines: barcodes.map(b => ({
        qualityId: GALAXY, gradeCode: 'LUMP', barcode: b, lotNo: `BAD-${stamp}`,
        receivedQty: 100, checkedQty: 100, rate: 30
      }))
    }
  });
  const issue = await api('/api/dyeing-issues', {
    method: 'POST',
    body: {
      processHouseId: PROCESS, entryDate: '2026-08-22',
      challanNo: `BADPC-${stamp}`, challanDate: '2026-08-22',
      lotNo: `BAD-${stamp}`, jobRate: 20, barcodes
    }
  });
  assert.equal(issue.status, 201, JSON.stringify(issue.body));

  // 200 out, 120 back is 40% gone. That is a claim, not a receipt.
  const r = await api('/api/dyeing-receipts/by-lot', {
    method: 'POST',
    body: {
      issueId: issue.body.id, entryDate: '2026-09-05',
      challanNo: `BADPR-${stamp}`, challanDate: '2026-09-05', jobRate: 20,
      pieces: [{ barcode: `BADFIN${stamp}`, qty: 120, finishGrade: 'A' }]
    }
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /the lot lost 40.00%/);
});

test('a barcode already on the floor cannot be reused for a finished thaan', async () => {
  const issue = await api(`/api/dyeing-issues/outstanding?processHouseId=${PROCESS}`);
  const open = (issue.body as any[])[0];
  if (!open) return;

  const r = await api('/api/dyeing-receipts/by-lot', {
    method: 'POST',
    body: {
      issueId: open.issue_id, entryDate: '2026-09-05',
      challanNo: `DUPPR-${stamp}`, challanDate: '2026-09-05', jobRate: 20,
      pieces: [{ barcode: `FIN${stamp}A`, qty: Number(open.issued_qty), finishGrade: 'A' }]
    }
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /already in use/);
});
