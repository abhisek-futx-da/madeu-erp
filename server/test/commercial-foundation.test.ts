/** Commercial cutover controls must work as real workflows, not just exist as tables. */
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { bootstrapTenant, type BootstrapInput } from '../src/bootstrap-tenant.ts';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const stamp = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
const input: BootstrapInput = {
  legalName: `Foundation Mills ${stamp}`,
  gstin: '27BCDEF1234G1Z5',
  pan: 'BCDEF1234G',
  stateCode: '27',
  fyStart: '2026-04-01',
  address1: '8 Commercial Textile Estate',
  city: 'Bhiwandi',
  pincode: '421302',
  email: `accounts.${stamp}@foundation.example`,
  ownerName: 'Foundation Owner',
  ownerEmail: `owner.${stamp}@foundation.example`,
  ownerPassword: 'FoundationOwnerPass123'
};

let tenantId = '';
let ownerToken = '';
let workerToken = '';
let branchId = '';
let openingId = '';
let debtorId = '';

function directDb() {
  return new pg.Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: process.env.PGUSER ?? 'postgres',
    database: process.env.TEST_DB ?? 'linkerp_test'
  });
}

async function api(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {}
) {
  const response = await fetch(`${BASE}/api${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function signIn(email: string, password: string) {
  return api('/auth/login', { method: 'POST', body: { email, password } });
}

test('new companies receive an authorised owner and an active main location', async () => {
  const db = directDb();
  await db.connect();
  try {
    const bootstrapped = await bootstrapTenant(db, input);
    tenantId = bootstrapped.tenantId;
  } finally {
    await db.end();
  }

  const login = await signIn(input.ownerEmail, input.ownerPassword);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  ownerToken = login.body.token;

  const me = await api('/me', { token: ownerToken });
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.deepEqual(me.body.permissions.sort(), [
    'write:accounts', 'write:masters', 'write:owner',
    'write:purchase', 'write:sales', 'write:store'
  ]);
  assert.equal(me.body.activeLocation.code, 'MAIN');
});

test('custom permission profiles control writes instead of merely labelling users', async () => {
  const profile = await api('/permission-profiles', {
    method: 'POST', token: ownerToken,
    body: {
      code: 'MASTER_ONLY', name: 'Master data only', baseRole: 'store',
      permissions: ['write:masters'], isActive: true
    }
  });
  assert.equal(profile.status, 201, JSON.stringify(profile.body));

  const workerEmail = `master.${stamp}@foundation.example`;
  const created = await api('/users', {
    method: 'POST', token: ownerToken,
    body: {
      email: workerEmail, fullName: 'Master Data Worker', role: 'store',
      permissionProfileId: profile.body.id, password: 'MasterWorkerPass123'
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const login = await signIn(workerEmail, 'MasterWorkerPass123');
  assert.equal(login.status, 200, JSON.stringify(login.body));
  workerToken = login.body.token;

  const allowed = await api('/hsn-codes', {
    method: 'POST', token: workerToken,
    body: { code: '5513', description: 'Foundation test fabric', gst_rate: 5, is_service: false }
  });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));

  const forbidden = await api('/grey-inwards', {
    method: 'POST', token: workerToken, body: {}
  });
  assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
});

test('the active branch owns newly created racks and cannot be disabled while in use', async () => {
  const branch = await api('/locations', {
    method: 'POST', token: ownerToken,
    body: {
      code: 'BHI-2', name: 'Bhiwandi Godown 2', kind: 'godown',
      address: 'Warehouse Lane', stateCode: '27', isDefault: false, isActive: true
    }
  });
  assert.equal(branch.status, 201, JSON.stringify(branch.body));
  branchId = branch.body.id;

  const selected = await api('/locations/active', {
    method: 'POST', token: ownerToken, body: { locationId: branchId }
  });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));

  const rack = await api('/racks', {
    method: 'POST', token: ownerToken,
    body: { code: 'B2-A01', name: 'Branch rack A01', location: 'Aisle A' }
  });
  assert.equal(rack.status, 201, JSON.stringify(rack.body));
  assert.equal(rack.body.business_location_id, branchId);

  const blocked = await api('/locations', {
    method: 'POST', token: ownerToken,
    body: {
      id: branchId, code: 'BHI-2', name: 'Bhiwandi Godown 2', kind: 'godown',
      address: 'Warehouse Lane', stateCode: '27', isDefault: false, isActive: false
    }
  });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /move active users, racks and stock/i);
});

test('saved views are private even when two users work in the same company', async () => {
  const workerView = await api('/saved-views', {
    method: 'POST', token: workerToken,
    body: { module: 'stock', name: 'My exceptions', filterText: 'short', columns: ['barcode'] }
  });
  assert.equal(workerView.status, 201, JSON.stringify(workerView.body));

  const ownerList = await api('/saved-views?module=stock', { token: ownerToken });
  assert.equal(ownerList.status, 200);
  assert.equal(ownerList.body.some((row: { id: string }) => row.id === workerView.body.id), false);

  const ownerDelete = await api(`/saved-views/${workerView.body.id}`, {
    method: 'DELETE', token: ownerToken
  });
  assert.equal(ownerDelete.status, 404);

  const workerList = await api('/saved-views?module=stock', { token: workerToken });
  assert.equal(workerList.status, 200);
  assert.equal(workerList.body.some((row: { id: string }) => row.id === workerView.body.id), true);
});

test('opening receivables are suggested, settled, and locked after live posting starts', async () => {
  const db = directDb();
  await db.connect();
  try {
    const debtorControl = await db.query<{ id: string }>(
      `select id from control_account where tenant_id=$1 and nature='sundry_debtor_finish'`,
      [tenantId]
    );
    const debtorControlId = debtorControl.rows[0]?.id;
    assert.ok(debtorControlId);
    const debtor = await db.query<{ id: string }>(
      `insert into ledger_account
         (tenant_id,code,name,control_account_id,gst_reg_type,credit_days)
       values ($1,'C-OPEN','Opening Customer',$2,'unregistered',30) returning id`,
      [tenantId, debtorControlId]
    );
    const createdDebtorId = debtor.rows[0]?.id;
    assert.ok(createdDebtorId);
    debtorId = createdDebtorId;
    await db.query(`delete from approval_rule where tenant_id=$1 and doc_type='payment'`, [tenantId]);
  } finally {
    await db.end();
  }

  const opening = await api('/opening-outstandings', {
    method: 'POST', token: ownerToken,
    body: {
      fyLabel: '2026-27', kind: 'receivable', partyId: debtorId,
      referenceNo: 'LEGACY-INV-001', documentDate: '2026-03-15',
      dueDate: '2026-04-14', originalAmount: 12500
    }
  });
  assert.equal(opening.status, 201, JSON.stringify(opening.body));
  openingId = opening.body.id;

  const suggested = await api('/payments/suggest', {
    method: 'POST', token: ownerToken,
    body: { partyId: debtorId, kind: 'receipt', amount: 5000 }
  });
  assert.equal(suggested.status, 200, JSON.stringify(suggested.body));
  assert.deepEqual(suggested.body.allocations[0], {
    openingOutstandingId: openingId, label: 'LEGACY-INV-001', amount: 5000
  });

  const receipt = await api('/payments', {
    method: 'POST', token: ownerToken,
    body: {
      kind: 'receipt', partyId: debtorId, paymentDate: '2026-04-20', mode: 'cash',
      amount: 5000, allocations: [{ openingOutstandingId: openingId, amount: 5000 }]
    }
  });
  assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
  assert.equal(receipt.body.status, 'approved');

  const remainder = await api('/payments/suggest', {
    method: 'POST', token: ownerToken,
    body: { partyId: debtorId, kind: 'receipt', amount: 20000 }
  });
  assert.equal(remainder.status, 200, JSON.stringify(remainder.body));
  assert.equal(remainder.body.allocations[0].openingOutstandingId, openingId);
  assert.equal(remainder.body.allocations[0].amount, 7500);

  const locked = await api('/opening-outstandings', {
    method: 'POST', token: ownerToken,
    body: {
      fyLabel: '2026-27', kind: 'receivable', partyId: debtorId,
      referenceNo: 'TOO-LATE', documentDate: '2026-03-31',
      dueDate: '2026-04-30', originalAmount: 100
    }
  });
  assert.equal(locked.status, 400);
  assert.match(locked.body.error, /locked after the first posted voucher/i);
});
