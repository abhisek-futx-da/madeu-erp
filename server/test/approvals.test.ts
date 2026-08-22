/**
 * Maker–checker.
 *
 * The guarantee worth having is not "there is an approve button" but "the
 * money did not move until a second person agreed". Every test here checks the
 * ledger, not the status column.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';

const PARTY_WEAVER = '33333333-0000-0000-0000-000000000105';
const PROCESS_HOUSE = '33333333-0000-0000-0000-000000000202';
const CUSTOMER = '33333333-0000-0000-0000-000000000701';
const QUALITY_GALAXY = '44444444-0000-0000-0000-000000000001';
const DEBTOR_CONTROL = '22222222-0000-0000-0000-000000000070';

const tokens: Record<string, string> = {};
const stamp = Date.now();
let bigBuyer = '';

async function api(
  path: string, opts: { method?: string; body?: unknown; as?: string } = {}
) {
  const token = tokens[opts.as ?? 'owner'];
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

/** The balance on a ledger by code — the only proof that matters here. */
async function ledgerBalance(code: string) {
  const r = await api('/api/reports/party-balance');
  return Number(r.body.find((x: any) => x.code === code)?.balance ?? 0);
}

async function trialBalanceDrift() {
  const r = await api('/api/reports/trial-balance?limit=5000');
  return r.body.reduce((n: number, x: any) => n + Number(x.balance), 0);
}

/** A dispatch worth roughly `rate * 95` per piece, ready to invoice. */
async function dispatchWorth(tag: string, pieces: number, rate: number, partyId = CUSTOMER) {
  const codes = Array.from({ length: pieces }, (_, i) => `AP${stamp}${tag}${i}`);
  await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: PARTY_WEAVER, entryDate: '2026-08-21', challanNo: `AP${stamp}${tag}-IN`,
      challanDate: '2026-08-21', lotNo: tag,
      lines: codes.map(barcode => ({
        qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode, lotNo: tag,
        receivedQty: 100, checkedQty: 100, rate: 30
      }))
    }
  });
  await api('/api/dyeing-issues', {
    method: 'POST',
    body: { processHouseId: PROCESS_HOUSE, entryDate: '2026-08-22',
            challanNo: `AP${stamp}${tag}-PC`, challanDate: '2026-08-22',
            lotNo: tag, jobRate: 18, barcodes: codes }
  });
  await api('/api/dyeing-receipts', {
    method: 'POST',
    body: { processHouseId: PROCESS_HOUSE, entryDate: '2026-09-05',
            challanNo: `AP${stamp}${tag}-PR`, challanDate: '2026-09-05',
            lines: codes.map(barcode => ({ barcode, receivedQty: 95, finishGrade: 'A', jobRate: 18 })) }
  });
  const d = await api('/api/dispatches', {
    method: 'POST',
    body: { partyId, challanNo: `AP${stamp}${tag}-DC`, challanDate: '2026-09-10',
            lines: codes.map(barcode => ({ barcode, rate })) }
  });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  return d.body.id as string;
}

test('sign in as everyone who matters', async () => {
  for (const who of ['owner', 'accounts', 'sales', 'store']) {
    const r = await api('/api/auth/login', {
      method: 'POST', body: { email: `${who}@neelkamal.test`, password: 'changeme' }
    });
    assert.equal(r.status, 200, `${who} should log in`);
    tokens[who] = r.body.token;
  }

  // Its own buyer, with a credit limit big enough not to be the thing that
  // fails, so these tests are about approval and nothing else.
  const c = await api('/api/ledgers', {
    method: 'POST',
    body: {
      code: `AP${stamp}`, name: `Approval Test Buyer ${stamp}`,
      control_account_id: DEBTOR_CONTROL, gstin: '33AAKCS9012P1ZT',
      gst_reg_type: 'regular', credit_days: 30, credit_limit: 99000000, is_active: true
    }
  });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  bigBuyer = c.body.id;
});

test('the seeded limits are readable', async () => {
  const r = await api('/api/approval-rules');
  assert.equal(r.status, 200);
  const byType = Object.fromEntries(r.body.map((x: any) => [x.doc_type, Number(x.min_amount)]));
  assert.equal(byType.payment, 100000);
  assert.ok(byType.sales_invoice > 0);
});

test('an ordinary invoice posts straight away', async () => {
  const before = await ledgerBalance('901');
  const dispatchId = await dispatchWorth('A', 1, 80);   // ~7,600
  const inv = await api('/api/sales-invoices', { method: 'POST', body: { dispatchId } });

  assert.equal(inv.status, 201);
  assert.equal(inv.body.status, 'approved');
  assert.equal(inv.body.awaitingApproval, null);
  assert.ok(
    Math.abs((await ledgerBalance('901')) - before + Number(inv.body.taxableValue)) < 0.01,
    'a below-threshold invoice should have reached the ledger'
  );
});

let heldInvoiceId = '';
let heldInvoiceTotal = 0;

test('an invoice over the limit is raised but does not touch the ledger', async () => {
  const salesBefore = await ledgerBalance('901');
  const partyBefore = await ledgerBalance(`AP${stamp}`);

  // 100 pieces at 95 mtr and ₹70 = ₹6,65,000, over the ₹5,00,000 limit.
  const dispatchId = await dispatchWorth('B', 100, 70, bigBuyer);
  const inv = await api('/api/sales-invoices', { method: 'POST', body: { dispatchId } });

  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal(inv.body.status, 'pending_approval');
  assert.equal(inv.body.awaitingApproval.role, 'owner');
  heldInvoiceId = inv.body.id;
  heldInvoiceTotal = Number(inv.body.invoiceTotal);

  assert.equal(await ledgerBalance('901'), salesBefore, 'revenue was recognised without approval');
  assert.equal(await ledgerBalance(`AP${stamp}`), partyBefore,
    'the customer was billed without approval');
});

test('a held invoice is on the queue with who raised it', async () => {
  const q = await api('/api/approvals/pending');
  assert.equal(q.status, 200);
  const mine = q.body.find((x: any) => x.doc_id === heldInvoiceId);
  assert.ok(mine, 'the held invoice should be waiting');
  assert.equal(mine.doc_type, 'sales_invoice');
  assert.equal(Number(mine.amount), heldInvoiceTotal);
  assert.equal(mine.approver_role, 'owner');
  assert.ok(mine.raised_by_name, 'the queue should name the maker');
});

test('a held invoice stays out of the outward return', async () => {
  const b3 = await api('/api/reports/gstr3b-outward');
  const sept = b3.body.find((p: any) => p.return_period === '09-2026');
  const invoices = await api('/api/sales-invoices?from=2026-09-01&to=2026-09-30&limit=500');
  const posted = invoices.body.rows.filter(
    (i: any) => i.status !== 'cancelled' && i.status !== 'pending_approval'
  );
  assert.equal(Number(sept.invoice_count), posted.length,
    'an unapproved invoice should not be declared as an outward supply');
});

test('the person who raised it cannot approve it', async () => {
  // The suite raises everything as owner, so owner is the maker here.
  const r = await api(`/api/approvals/sales_invoice/${heldInvoiceId}/approve`, {
    method: 'POST', body: { note: 'trying to wave my own document through' }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /raised by you|second person/i);
});

test('someone without the role cannot approve it either', async () => {
  const r = await api(`/api/approvals/sales_invoice/${heldInvoiceId}/approve`, {
    method: 'POST', as: 'store', body: {}
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /role/i);
});

test('a second person with the role releases it, and only then does it post', async () => {
  // Hand the document to someone else so approval is a genuine second pair of
  // eyes rather than a rename of the same person.
  const handover = await api('/api/auth/login', {
    method: 'POST', body: { email: 'accounts@neelkamal.test', password: 'changeme' }
  });
  assert.equal(handover.status, 200);

  await api('/api/approval-rules', {
    method: 'POST',
    body: { docType: 'sales_invoice', minAmount: 500000, approverRole: 'accounts' }
  });

  const salesBefore = await ledgerBalance('901');
  const r = await api(`/api/approvals/sales_invoice/${heldInvoiceId}/approve`, {
    method: 'POST', as: 'accounts', body: { note: 'checked against the order' }
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'approved');
  assert.ok(r.body.voucherNo, 'approval should have posted a voucher');

  const moved = (await ledgerBalance('901')) - salesBefore;
  assert.ok(Math.abs(moved) > 0.01, 'approval did not post anything');
  assert.ok(Math.abs(await trialBalanceDrift()) < 0.01, 'the books drifted on approval');
});

test('it cannot be approved twice', async () => {
  const r = await api(`/api/approvals/sales_invoice/${heldInvoiceId}/approve`, {
    method: 'POST', as: 'accounts', body: {}
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not awaiting approval|approved/i);
});

test('two approvers clicking together post exactly one voucher', async () => {
  await api('/api/approval-rules', {
    method: 'POST',
    body: { docType: 'sales_invoice', minAmount: 100, approverRole: 'accounts' }
  });
  const dispatchId = await dispatchWorth('C', 2, 90, bigBuyer);
  const inv = await api('/api/sales-invoices', { method: 'POST', body: { dispatchId } });
  assert.equal(inv.body.status, 'pending_approval');

  const before = await ledgerBalance('901');
  const [a, b] = await Promise.all([
    api(`/api/approvals/sales_invoice/${inv.body.id}/approve`, { method: 'POST', as: 'accounts', body: {} }),
    api(`/api/approvals/sales_invoice/${inv.body.id}/approve`, { method: 'POST', as: 'accounts', body: {} })
  ]);
  assert.equal([a, b].filter(r => r.status === 200).length, 1,
    `both approvals succeeded: ${JSON.stringify([a.body, b.body])}`);

  const moved = before - (await ledgerBalance('901'));
  assert.ok(
    Math.abs(moved - Number(inv.body.taxableValue)) < 0.01,
    `revenue moved by ${moved}, the invoice was ${inv.body.taxableValue}`
  );
});

test('a rejected document never reaches the ledger at all', async () => {
  const dispatchId = await dispatchWorth('D', 2, 85, bigBuyer);
  const inv = await api('/api/sales-invoices', { method: 'POST', body: { dispatchId } });
  assert.equal(inv.body.status, 'pending_approval');

  const before = await ledgerBalance('901');
  const r = await api(`/api/approvals/sales_invoice/${inv.body.id}/reject`, {
    method: 'POST', as: 'accounts', body: { reason: 'rate does not match the order' }
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'rejected');

  assert.equal(await ledgerBalance('901'), before, 'a rejected invoice posted revenue');
  assert.ok(Math.abs(await trialBalanceDrift()) < 0.01);

  const q = await api('/api/approvals/pending');
  assert.ok(!q.body.some((x: any) => x.doc_id === inv.body.id), 'it is still on the queue');
});

test('a payment over the limit waits, and the bank is untouched until it clears', async () => {
  const cashBefore = await ledgerBalance('970');
  const pay = await api('/api/payments', {
    method: 'POST',
    body: {
      kind: 'payment', partyId: PARTY_WEAVER, paymentDate: '2026-09-20',
      mode: 'cash', amount: 250000, narration: 'part settlement'
    }
  });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  assert.equal(pay.body.status, 'pending_approval');
  assert.equal(await ledgerBalance('970'), cashBefore, 'cash left before anyone approved');

  const cleared = await api(`/api/approvals/payment/${pay.body.id}/approve`, {
    method: 'POST', as: 'accounts', body: {}
  });
  // The seeded rule names the owner for payments; accounts must be refused.
  assert.equal(cleared.status, 400);

  const byOwner = await api(`/api/approvals/payment/${pay.body.id}/approve`, {
    method: 'POST', as: 'accounts', body: {}
  });
  assert.equal(byOwner.status, 400, 'the role check must not soften on a retry');

  await api('/api/approval-rules', {
    method: 'POST', body: { docType: 'payment', minAmount: 100000, approverRole: 'accounts' }
  });
  const finally_ = await api(`/api/approvals/payment/${pay.body.id}/approve`, {
    method: 'POST', as: 'accounts', body: {} });
  assert.equal(finally_.status, 200, JSON.stringify(finally_.body));

  const moved = cashBefore - (await ledgerBalance('970'));
  assert.ok(Math.abs(moved - 250000) < 0.01, `cash moved by ${moved}, expected 250000`);
});

test('the history records who did what', async () => {
  const h = await api('/api/approvals/history');
  assert.equal(h.status, 200);
  assert.ok(h.body.length > 0);
  const actions = new Set(h.body.map((x: any) => x.action));
  assert.ok(actions.has('submitted'));
  assert.ok(actions.has('approved'));
  assert.ok(actions.has('rejected'));
  for (const row of h.body.slice(0, 5)) {
    assert.ok(row.actor, 'every event should name its actor');
  }
});

test('only the owner may change an approval limit', async () => {
  const r = await api('/api/approval-rules', {
    method: 'POST', as: 'sales',
    body: { docType: 'sales_invoice', minAmount: 0, approverRole: 'sales' }
  });
  assert.equal(r.status, 403);
});

test('restore the seeded limits so the rest of the suite is unaffected', async () => {
  for (const [docType, minAmount, role] of [
    ['sales_invoice', 500000, 'owner'],
    ['purchase_invoice', 300000, 'owner'],
    ['payment', 100000, 'owner']
  ] as const) {
    const r = await api('/api/approval-rules', {
      method: 'POST', body: { docType, minAmount, approverRole: role }
    });
    assert.equal(r.status, 201);
  }
});
