/** The real-mill initializer must produce an empty, usable tenant atomically. */
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { bootstrapTenant, type BootstrapInput } from '../src/bootstrap-tenant.ts';

const stamp = `${Date.now()}${Math.floor(Math.random() * 10000)}`;

function directDb() {
  return new pg.Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: process.env.PGUSER ?? 'postgres',
    database: process.env.TEST_DB ?? 'linkerp_test'
  });
}

const input: BootstrapInput = {
  legalName: `Pilot Looms ${stamp}`,
  gstin: '27ABCDE1234F1Z5',
  pan: 'ABCDE1234F',
  stateCode: '27',
  fyStart: '2026-04-01',
  address1: '1 Textile Market Road',
  city: 'Bhiwandi',
  pincode: '421302',
  email: `accounts.${stamp}@pilot.example`,
  ownerName: 'Pilot Owner',
  ownerEmail: `owner.${stamp}@pilot.example`,
  ownerPassword: 'PilotOwnerPassword123'
};

let pilotTenantId = '';
let pilotOwnerId = '';
let pilotToken = '';

test('a real-mill bootstrap creates only the neutral, usable company foundation', async () => {
  const db = directDb();
  await db.connect();
  try {
    const result = await bootstrapTenant(db, input);
    pilotTenantId = result.tenantId;
    pilotOwnerId = result.ownerId;
    assert.equal(result.financialYear, '2026-27');
    assert.equal(result.ownerEmail, input.ownerEmail);
    assert.equal(result.systemLedgers, 22);

    const tenant = await db.query<{
      legal_name: string; gstin: string; pan: string; state_code: string; fy_start: string;
    }>(`select legal_name, gstin, pan, state_code, fy_start::text from tenant where id = $1`, [result.tenantId]);
    assert.deepEqual(tenant.rows[0], {
      legal_name: input.legalName, gstin: input.gstin, pan: input.pan,
      state_code: input.stateCode, fy_start: input.fyStart
    });

    const counts = await db.query<{ controls: number; ledgers: number; roles: number; units: number; series: number; banks: number; parties: number; qualities: number; tds: number }>(
      `select
         (select count(*)::int from control_account where tenant_id = $1) as controls,
         (select count(*)::int from ledger_account where tenant_id = $1) as ledgers,
         (select count(*)::int from ledger_account where tenant_id = $1 and posting_role is not null) as roles,
         (select count(*)::int from unit_master where tenant_id = $1) as units,
         (select count(*)::int from document_series where tenant_id = $1) as series,
         (select count(*)::int from bank_account where tenant_id = $1) as banks,
         (select count(*)::int from ledger_account where tenant_id = $1 and code < '900') as parties,
         (select count(*)::int from quality where tenant_id = $1) as qualities,
         (select count(*)::int from tax_deduction_section where tenant_id = $1) as tds`,
      [result.tenantId]
    );
    assert.deepEqual(counts.rows[0], {
      controls: 23, ledgers: 22, roles: 21, units: 4, series: 29,
      banks: 0, parties: 0, qualities: 0, tds: 0
    });

    const settings = await db.query<{ key: string; value: boolean | string }>(
      `select key, value from tenant_setting where tenant_id = $1 order by key`, [result.tenantId]
    );
    assert.deepEqual(settings.rows, [
      { key: 'credit.enforce_limit', value: true },
      { key: 'invoice.rounding', value: 'nearest_rupee' }
    ]);
    const stockControl = await db.query<{ doc_type: string; min_amount: number; approver_role: string }>(
      `select doc_type, min_amount::float8 as min_amount, approver_role from approval_rule where tenant_id = $1 order by doc_type`, [result.tenantId]
    );
    assert.deepEqual(stockControl.rows.map(r => r.doc_type), [
      'customer_return', 'dyeing_reprocess_receipt', 'dyeing_return', 'grey_return', 'payment',
      'purchase_invoice', 'sales_invoice', 'stock_count', 'write_off'
    ]);
    assert.ok(stockControl.rows.every(r => r.min_amount === 0 && r.approver_role === 'owner'));
    const owner = await db.query<{ email: string; role: string; is_active: boolean; session_version: number }>(
      `select u.email, m.role::text, m.is_active, u.session_version
         from app_user u join membership m on m.user_id = u.id
        where m.tenant_id = $1 and u.id = $2`, [result.tenantId, result.ownerId]
    );
    assert.deepEqual(owner.rows, [{
      email: input.ownerEmail, role: 'owner', is_active: true, session_version: 0
    }]);
  } finally {
    await db.end();
  }
});

async function pilotApi(path: string, options: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${process.env.API_BASE ?? 'http://127.0.0.1:4000'}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${pilotToken}` },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('opening books are explicit, balanced, audited, and included in trial balance', async () => {
  const login = await fetch(`${process.env.API_BASE ?? 'http://127.0.0.1:4000'}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: input.ownerEmail, password: input.ownerPassword })
  });
  assert.equal(login.status, 200);
  pilotToken = ((await login.json()) as { token: string }).token;

  const db = directDb();
  await db.connect();
  try {
    const ledgers = await db.query<{ id: string; code: string }>(
      `select id, code from ledger_account
        where tenant_id=$1 and code in ('950','970') order by code`, [pilotTenantId]);
    const retained = ledgers.rows.find(l => l.code === '950')!;
    const cash = ledgers.rows.find(l => l.code === '970')!;
    assert.ok(retained && cash);

    const unbalanced = await pilotApi('/api/opening-balances/2026-27', {
      method: 'POST', body: { entries: [{ ledgerId: cash.id, debit: 125000, credit: 0 }] }
    });
    assert.equal(unbalanced.status, 400);
    assert.match(unbalanced.body.error, /out by/i);

    const saved = await pilotApi('/api/opening-balances/2026-27', {
      method: 'POST', body: { entries: [
        { ledgerId: cash.id, debit: 125000, credit: 0 },
        { ledgerId: retained.id, debit: 0, credit: 125000 }
      ] }
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.totalDebit, 125000);
    assert.equal(saved.body.totalCredit, 125000);

    const trial = await pilotApi('/api/reports/trial-balance');
    assert.equal(trial.status, 200);
    assert.equal(Number(trial.body.find((r: any) => r.code === '970').balance), 125000);
    assert.equal(Number(trial.body.find((r: any) => r.code === '950').balance), -125000);
    assert.equal(trial.body.reduce((n: number, r: any) => n + Number(r.balance), 0), 0);

    const revisions = await db.query<{ n: number }>(
      'select count(*)::int as n from opening_balance_revision where tenant_id=$1', [pilotTenantId]);
    assert.equal(revisions.rows[0]?.n, 1);

    await db.query('begin');
    const voucher = await db.query<{ id: string }>(
      `insert into voucher (tenant_id,voucher_no,voucher_type,voucher_date,narration,is_posted,created_by)
       values ($1,'OPEN-TEST','journal','2026-04-02','opening carry regression',true,$2) returning id`,
      [pilotTenantId, pilotOwnerId]);
    await db.query(
      `insert into voucher_line (tenant_id,voucher_id,ledger_id,debit,credit)
       values ($1,$2,$3,1000,0),($1,$2,$4,0,1000)`,
      [pilotTenantId, voucher.rows[0]?.id, cash.id, retained.id]);
    await db.query('commit');

    const locked = await pilotApi('/api/opening-balances/2026-27', {
      method: 'POST', body: { entries: [
        { ledgerId: cash.id, debit: 1, credit: 0 },
        { ledgerId: retained.id, debit: 0, credit: 1 }
      ] }
    });
    assert.equal(locked.status, 400);
    assert.match(locked.body.error, /locked after the first posted voucher/i);

    const closed = await pilotApi('/api/financial-years/2026-27/close', {
      method: 'POST', body: { nextLabel: '2027-28' }
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));

    const carried = await db.query<{ code: string; debit: number; credit: number }>(
      `select la.code, ob.debit::float8 as debit, ob.credit::float8 as credit
         from opening_balance ob join ledger_account la on la.id=ob.ledger_id
        where ob.tenant_id=$1 and ob.fy_label='2027-28' and la.code in ('950','970')
        order by la.code`, [pilotTenantId]);
    assert.deepEqual(carried.rows, [
      { code: '950', debit: 0, credit: 126000 },
      { code: '970', debit: 126000, credit: 0 }
    ]);
    const nextYear = await db.query<{ label: string; prefix: string }>(
      `select fy.label, ds.prefix from financial_year fy
         join document_series ds on ds.tenant_id=fy.tenant_id and ds.fy_label=fy.label
        where fy.tenant_id=$1 and fy.label='2027-28' and ds.doc_type='sales_invoice'`,
      [pilotTenantId]);
    assert.equal(nextYear.rows[0]?.label, '2027-28');
    assert.match(nextYear.rows[0]?.prefix ?? '', /27-28/);
  } finally { await db.end(); }
});

test('a voucher outside every configured financial year is refused by the database', async () => {
  const db = directDb(); await db.connect();
  try {
    await assert.rejects(() => db.query(
      `insert into voucher (tenant_id,voucher_no,voucher_type,voucher_date,is_posted,created_by)
       values ($1,'NO-FY','journal','2035-04-01',false,$2)`, [pilotTenantId, pilotOwnerId]
    ), /no financial year is configured/i);
  } finally { await db.end(); }
});

test('a duplicate bootstrap leaves no half-created second company', async () => {
  const db = directDb();
  await db.connect();
  try {
    await assert.rejects(() => bootstrapTenant(db, input), /duplicate key|unique/i);
    const tenants = await db.query<{ n: number }>('select count(*)::int as n from tenant where gstin = $1', [input.gstin]);
    const owners = await db.query<{ n: number }>('select count(*)::int as n from app_user where email = $1', [input.ownerEmail]);
    assert.equal(tenants.rows[0]?.n, 1);
    assert.equal(owners.rows[0]?.n, 1);
  } finally {
    await db.end();
  }
});
