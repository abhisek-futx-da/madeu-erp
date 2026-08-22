/**
 * Two users clicking at the same moment.
 *
 * Every guard in this file was already "covered" by a test whose name promised
 * it — but those tests fired their two requests one after the other, and the
 * defects lived precisely in the gap. Both of the first two cases below were
 * demonstrated against a running instance before the fix: two tax invoices for
 * one dispatch, and a receivable driven negative by paying a bill twice.
 *
 * Anything asserted here must hold when the requests overlap, not merely when
 * they are polite about taking turns.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';

const PARTY_WEAVER = '33333333-0000-0000-0000-000000000105';
const PROCESS_HOUSE = '33333333-0000-0000-0000-000000000202';
const DEBTOR_CONTROL = '22222222-0000-0000-0000-000000000070';
const QUALITY_GALAXY = '44444444-0000-0000-0000-000000000001';

let token = '';
/**
 * This suite bills a customer of its own. Sharing the demo one meant every
 * previous run ate into the same credit limit, so the tests began failing on
 * accumulated state rather than on anything they were written to check.
 */
let CUSTOMER = '';
const stamp = Date.now();

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

/** Grey in, out to dyeing, back, dispatched — one piece, ready to invoice. */
async function dispatchReadyToInvoice(tag: string, rate = 80) {
  const barcode = `CC${stamp}${tag}`;
  await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: PARTY_WEAVER, entryDate: '2026-08-21', challanNo: `CC${stamp}${tag}-IN`,
      challanDate: '2026-08-21', lotNo: tag,
      lines: [{ qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode, lotNo: tag,
                receivedQty: 100, checkedQty: 100, rate: 30 }]
    }
  });
  await api('/api/dyeing-issues', {
    method: 'POST',
    body: { processHouseId: PROCESS_HOUSE, entryDate: '2026-08-22',
            challanNo: `CC${stamp}${tag}-PC`, challanDate: '2026-08-22',
            lotNo: tag, jobRate: 18, barcodes: [barcode] }
  });
  await api('/api/dyeing-receipts', {
    method: 'POST',
    body: { processHouseId: PROCESS_HOUSE, entryDate: '2026-09-05',
            challanNo: `CC${stamp}${tag}-PR`, challanDate: '2026-09-05',
            lines: [{ barcode, receivedQty: 95, finishGrade: 'A', jobRate: 18 }] }
  });
  const d = await api('/api/dispatches', {
    method: 'POST',
    body: { partyId: CUSTOMER, challanNo: `CC${stamp}${tag}-DC`, challanDate: '2026-09-10',
            lines: [{ barcode, rate }] }
  });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  return { dispatchId: d.body.id as string, barcode };
}

test('sign in', async () => {
  const r = await api('/api/auth/login', {
    method: 'POST', body: { email: 'owner@neelkamal.test', password: 'changeme' }
  });
  assert.equal(r.status, 200);
  token = r.body.token;

  const customer = await api('/api/ledgers', {
    method: 'POST',
    body: {
      code: `CC${stamp}`, name: `Concurrency Test Buyer ${stamp}`,
      control_account_id: DEBTOR_CONTROL,
      gstin: '33AAKCS9012P1ZT', gst_reg_type: 'regular',
      credit_days: 30, credit_limit: 99_000_000, is_active: true
    }
  });
  assert.equal(customer.status, 201, JSON.stringify(customer.body));
  CUSTOMER = customer.body.id;
});

test('two simultaneous invoices for one dispatch produce exactly one', async () => {
  const { dispatchId } = await dispatchReadyToInvoice('A');

  const [a, b] = await Promise.all([
    api('/api/sales-invoices', { method: 'POST', body: { dispatchId } }),
    api('/api/sales-invoices', { method: 'POST', body: { dispatchId } })
  ]);

  const created = [a, b].filter(r => r.status === 201);
  const refused = [a, b].filter(r => r.status !== 201);
  assert.equal(created.length, 1, `both attempts succeeded: ${JSON.stringify([a.body, b.body])}`);
  assert.equal(refused.length, 1);
  // Either the row lock refuses it or the unique index does; both are correct.
  assert.ok([400, 409].includes(refused[0]!.status), `unexpected ${refused[0]!.status}`);

  const list = await api('/api/sales-invoices?limit=500');
  const forThis = list.body.rows.filter(
    (i: any) => i.status !== 'cancelled' && i.invoice_no === created[0]!.body.invoiceNo
  );
  assert.equal(forThis.length, 1);
});

test('an invoice cannot be paid twice over, even simultaneously', async () => {
  const { dispatchId } = await dispatchReadyToInvoice('B', 55);
  const inv = await api('/api/sales-invoices', { method: 'POST', body: { dispatchId } });
  assert.equal(inv.status, 201);
  const total = Number(inv.body.invoiceTotal);

  const pay = () => api('/api/payments', {
    method: 'POST',
    body: {
      kind: 'receipt', partyId: CUSTOMER, paymentDate: '2026-09-20', mode: 'cash',
      amount: total, allocations: [{ salesInvoiceId: inv.body.id, amount: total }]
    }
  });
  const [a, b] = await Promise.all([pay(), pay()]);

  assert.equal([a, b].filter(r => r.status === 201).length, 1,
    `both receipts allocated: ${JSON.stringify([a.body, b.body])}`);

  const out = await api('/api/reports/outstanding-sales?limit=5000');
  const row = out.body.find((r: any) => r.invoice_id === inv.body.id);
  assert.ok(row, 'the invoice should still be listed');
  assert.equal(Number(row.paid), total, 'paid more than the invoice was worth');
  assert.equal(Number(row.outstanding), 0);
});

test('an invoice can never show a negative outstanding', async () => {
  const out = await api('/api/reports/outstanding-sales?limit=5000');
  const negative = out.body.filter((r: any) => Number(r.outstanding) < -0.005);
  assert.deepEqual(
    negative.map((r: any) => `${r.invoice_no}: ${r.outstanding}`), [],
    'a negative receivable means an invoice was over-allocated'
  );
});

test('a piece cannot be dispatched twice at the same instant', async () => {
  const barcode = `CCD${stamp}`;
  await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: PARTY_WEAVER, entryDate: '2026-08-21', challanNo: `CCD${stamp}-IN`,
      challanDate: '2026-08-21', lotNo: 'CCD',
      lines: [{ qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode, lotNo: 'CCD',
                receivedQty: 100, checkedQty: 100, rate: 30 }]
    }
  });
  await api('/api/dyeing-issues', {
    method: 'POST',
    body: { processHouseId: PROCESS_HOUSE, entryDate: '2026-08-22', challanNo: `CCD${stamp}-PC`,
            challanDate: '2026-08-22', lotNo: 'CCD', jobRate: 18, barcodes: [barcode] }
  });
  await api('/api/dyeing-receipts', {
    method: 'POST',
    body: { processHouseId: PROCESS_HOUSE, entryDate: '2026-09-05', challanNo: `CCD${stamp}-PR`,
            challanDate: '2026-09-05',
            lines: [{ barcode, receivedQty: 95, finishGrade: 'A', jobRate: 18 }] }
  });

  const ship = (n: number) => api('/api/dispatches', {
    method: 'POST',
    body: { partyId: CUSTOMER, challanNo: `CCD${stamp}-DC${n}`, challanDate: '2026-09-10',
            lines: [{ barcode, rate: 90 }] }
  });
  const [a, b] = await Promise.all([ship(1), ship(2)]);

  assert.equal([a, b].filter(r => r.status === 201).length, 1,
    `the same piece shipped twice: ${JSON.stringify([a.body, b.body])}`);

  const history = await api(`/api/pieces/${barcode}/history`);
  const shipped = history.body.filter((h: any) => h.to_status === 'dispatched');
  assert.equal(shipped.length, 1, 'the movement log records two dispatches for one piece');
});

test('concurrent document numbering never issues the same number twice', async () => {
  const attempts = 8;
  const results = await Promise.all(
    Array.from({ length: attempts }, (_, i) =>
      api('/api/sales-orders', {
        method: 'POST',
        body: {
          partyId: CUSTOMER, orderDate: '2026-09-01',
          lines: [{ qualityId: QUALITY_GALAXY, gradeCode: 'A', pcs: 1,
                    cutLength: 100, qty: 100, rate: 70 + i }]
        }
      })
    )
  );

  const numbers = results.filter(r => r.status === 201).map(r => r.body.orderNo);
  assert.equal(numbers.length, attempts, 'some concurrent orders were refused outright');
  assert.equal(new Set(numbers).size, attempts, `duplicate order numbers: ${numbers.join(', ')}`);
});

test('overlapping scans of the same pieces do not deadlock', async () => {
  // Two operators picking the same pieces in opposite order is what produced
  // a raw Postgres deadlock before the locking selects were given an ORDER BY.
  const codes = [0, 1, 2, 3].map(i => `CCL${stamp}${i}`);
  await api('/api/grey-inwards', {
    method: 'POST',
    body: {
      partyId: PARTY_WEAVER, entryDate: '2026-08-21', challanNo: `CCL${stamp}-IN`,
      challanDate: '2026-08-21', lotNo: 'CCL',
      lines: codes.map(barcode => ({
        qualityId: QUALITY_GALAXY, gradeCode: 'LUMP', barcode, lotNo: 'CCL',
        receivedQty: 100, checkedQty: 100, rate: 30
      }))
    }
  });

  const issue = (order: string[], n: number) => api('/api/dyeing-issues', {
    method: 'POST',
    body: { processHouseId: PROCESS_HOUSE, entryDate: '2026-08-22',
            challanNo: `CCL${stamp}-PC${n}`, challanDate: '2026-08-22',
            lotNo: 'CCL', jobRate: 18, barcodes: order }
  });

  const [a, b] = await Promise.all([issue(codes, 1), issue([...codes].reverse(), 2)]);

  // One wins and one is refused because the pieces have already moved. What
  // must not happen is a deadlock, which surfaces as a 409 from code 40P01.
  const statuses = [a.status, b.status].sort();
  assert.equal(statuses.filter(s => s === 201).length, 1,
    `expected exactly one to succeed, got ${JSON.stringify([a.body, b.body])}`);
  assert.ok(!JSON.stringify([a.body, b.body]).includes('deadlock'),
    'the two overlapping scans deadlocked');
});
