import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const tokens: Record<string, string> = {};
const stamp = Date.now();
let bankLedgerId = '';
let bankAccountId = '';
let receiptId = '';
let paymentId = '';
let reconciliationId = '';
let positiveLineId = '';
let negativeLineId = '';

async function api(path: string, opts: { method?: string; body?: unknown; as?: string } = {}) {
  const token = tokens[opts.as ?? 'owner'] ?? '';
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('bank reconciliation setup uses its own bank ledger', async () => {
  for (const who of ['owner', 'accounts']) {
    const r = await api('/api/auth/login', {
      method: 'POST', body: { email: `${who}@neelkamal.test`, password: 'changeme' }
    });
    assert.equal(r.status, 200);
    tokens[who] = r.body.token;
  }
  const controls = await api('/api/control-accounts');
  const bankControl = controls.body.find((row: any) => row.nature === 'bank');
  assert.ok(bankControl);
  const ledger = await api('/api/ledgers', {
    method: 'POST',
    body: {
      code: `BR${stamp}`, name: `Reconciliation Bank ${stamp}`,
      control_account_id: bankControl.id, gst_reg_type: 'unregistered', is_active: true
    }
  });
  assert.equal(ledger.status, 201, JSON.stringify(ledger.body));
  bankLedgerId = ledger.body.id;
  const bank = await api('/api/bank-accounts', {
    method: 'POST',
    body: {
      ledger_id: bankLedgerId, bank_name: 'Test Bank', account_no: `BR${stamp}`,
      ifsc: 'TEST0123456', branch: 'Test', is_default: false
    }
  });
  assert.equal(bank.status, 201, JSON.stringify(bank.body));
  bankAccountId = bank.body.id;
});

test('book entries are imported only through posted payments', async () => {
  const receipt = await api('/api/payments', {
    method: 'POST', as: 'accounts',
    body: {
      kind: 'receipt', partyId: '33333333-0000-0000-0000-000000000701',
      paymentDate: '2026-10-05', mode: 'neft', amount: 2500,
      bankLedgerId, instrumentNo: `UTR-IN-${stamp}`, narration: 'bank reconciliation receipt'
    }
  });
  assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
  assert.equal(receipt.body.status, 'approved');
  receiptId = receipt.body.id;

  const payment = await api('/api/payments', {
    method: 'POST', as: 'accounts',
    body: {
      kind: 'payment', partyId: '33333333-0000-0000-0000-000000000105',
      paymentDate: '2026-10-10', mode: 'neft', amount: 1000,
      bankLedgerId, instrumentNo: `UTR-OUT-${stamp}`, narration: 'bank reconciliation payment'
    }
  });
  assert.equal(payment.status, 201, JSON.stringify(payment.body));
  assert.equal(payment.body.status, 'approved');
  paymentId = payment.body.id;
});

test('an incomplete statement is refused before it becomes evidence', async () => {
  const bad = await api('/api/bank-reconciliations', {
    method: 'POST', as: 'accounts',
    body: {
      bankAccountId, statementFrom: '2026-10-01', statementTo: '2026-10-31',
      openingBalance: 0, closingBalance: 999,
      lines: [{ txnDate: '2026-10-05', amount: 2500, reference: `UTR-IN-${stamp}` }]
    }
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /does not add up/i);
});

test('an accounts maker imports a balanced statement and sees exact candidates', async () => {
  const created = await api('/api/bank-reconciliations', {
    method: 'POST', as: 'accounts',
    body: {
      bankAccountId, statementFrom: '2026-10-01', statementTo: '2026-10-31',
      openingBalance: 0, closingBalance: 1500,
      lines: [
        { txnDate: '2026-10-05', amount: 2500, reference: `UTR-IN-${stamp}`, description: 'customer transfer' },
        { txnDate: '2026-10-10', amount: -1000, reference: `UTR-OUT-${stamp}`, description: 'supplier transfer' }
      ]
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  reconciliationId = created.body.id;

  const detail = await api(`/api/bank-reconciliations/${reconciliationId}`, { as: 'accounts' });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.lines.length, 2);
  assert.equal(detail.body.candidates.length, 2);
  positiveLineId = detail.body.lines.find((line: any) => Number(line.amount) > 0).id;
  negativeLineId = detail.body.lines.find((line: any) => Number(line.amount) < 0).id;
  assert.equal(Number(detail.body.summary.statementArithmeticDifference), 0);
});

test('direction and amount must agree before a statement line can match', async () => {
  const wrong = await api(
    `/api/bank-reconciliations/${reconciliationId}/lines/${positiveLineId}/match`,
    { method: 'POST', as: 'accounts', body: { paymentId } }
  );
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /does not equal/i);

  for (const [lineId, candidateId] of [[positiveLineId, receiptId], [negativeLineId, paymentId]]) {
    const matched = await api(`/api/bank-reconciliations/${reconciliationId}/lines/${lineId}/match`, {
      method: 'POST', as: 'accounts', body: { paymentId: candidateId }
    });
    assert.equal(matched.status, 200, JSON.stringify(matched.body));
  }
});

test('the maker cannot close and only a different owner can freeze a zero-difference reconciliation', async () => {
  const maker = await api(`/api/bank-reconciliations/${reconciliationId}/complete`, {
    method: 'POST', as: 'accounts', body: {}
  });
  assert.equal(maker.status, 403);

  const completed = await api(`/api/bank-reconciliations/${reconciliationId}/complete`, {
    method: 'POST', as: 'owner', body: {}
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(Number(completed.body.summary.difference), 0);

  const frozen = await api(`/api/bank-reconciliations/${reconciliationId}/lines/${positiveLineId}/unmatch`, {
    method: 'POST', as: 'owner', body: {}
  });
  assert.equal(frozen.status, 400);
  assert.match(frozen.body.error, /draft/i);

  const detail = await api(`/api/bank-reconciliations/${reconciliationId}`);
  assert.equal(detail.body.reconciliation.status, 'completed');
  assert.equal(detail.body.summary.matchedLines, 2);
});
