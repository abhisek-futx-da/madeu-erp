import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
let owner = '';
let viewer = '';

async function api(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: response.headers };
}

test('migration workbench users sign in', async () => {
  for (const [email, save] of [
    ['owner@neelkamal.test', (token: string) => { owner = token; }],
    ['viewer@neelkamal.test', (token: string) => { viewer = token; }]
  ] as const) {
    const response = await api('/api/auth/login', {
      method: 'POST', body: { email, password: 'changeme' }
    });
    assert.equal(response.status, 200);
    save(response.body.token);
  }
});

test('Excel-compatible templates are authenticated CSV downloads', async () => {
  const noAuth = await api('/api/onboarding/templates/grades');
  assert.equal(noAuth.status, 401);
  const response = await api('/api/onboarding/templates/grades', { token: owner });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/csv/);
  assert.match(String(response.body), /code,name,sort_order/);
});

test('preview explains duplicates and missing references without changing masters', async () => {
  const before = await api('/api/qualities?q=IMP-BAD', { token: owner });
  assert.deepEqual(before.body, []);
  const response = await api('/api/onboarding/imports/preview', {
    method: 'POST', token: owner, body: {
      resource: 'qualities', filename: 'quality-errors.csv', rows: [
        { code: 'IMP-BAD', name: 'Bad one', construction: '', selvedge_line: '', width_cms: '147',
          bill_by: 'meters', hsn_code: '999999', division: 'Shirting', is_active: 'yes' },
        { code: 'IMP-BAD', name: 'Bad two', construction: '', selvedge_line: '', width_cms: '147',
          bill_by: 'meters', hsn_code: '999999', division: 'Shirting', is_active: 'yes' }
      ]
    }
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.errorRows, 2);
  assert.ok(response.body.rows.every((row: any) => row.action === 'error'));
  assert.match(response.body.rows[0].errors.join(' '), /does not exist/);
  assert.match(response.body.rows[0].errors.join(' '), /duplicate/);

  const blocked = await api(`/api/onboarding/imports/${response.body.id}/apply`, {
    method: 'POST', token: owner, body: {}
  });
  assert.equal(blocked.status, 400);
  const after = await api('/api/qualities?q=IMP-BAD', { token: owner });
  assert.deepEqual(after.body, []);
});

test('only an owner can preview or apply a migration', async () => {
  const response = await api('/api/onboarding/imports/preview', {
    method: 'POST', token: viewer, body: {
      resource: 'grades', filename: 'forbidden.csv', rows: [{ code: 'NO', name: 'No', sort_order: '1' }]
    }
  });
  assert.equal(response.status, 403);
});

test('a clean batch inserts and updates atomically, once', async () => {
  const suffix = String(Date.now()).slice(-7);
  const code = `I${suffix}`;
  const response = await api('/api/onboarding/imports/preview', {
    method: 'POST', token: owner, body: {
      resource: 'grades', filename: 'grades.csv', rows: [
        { code: 'A', name: 'A Grade — verified', sort_order: '4' },
        { code, name: 'Imported grade', sort_order: '90' }
      ]
    }
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.errorRows, 0);
  assert.deepEqual(response.body.rows.map((row: any) => row.action), ['update', 'insert']);

  const applied = await api(`/api/onboarding/imports/${response.body.id}/apply`, {
    method: 'POST', token: owner, body: {}
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.appliedRows, 2);
  const inserted = await api(`/api/grades?q=${code}`, { token: owner });
  assert.equal(inserted.body[0].name, 'Imported grade');
  const updated = await api('/api/grades?q=A', { token: owner });
  assert.ok(updated.body.some((row: any) => row.code === 'A' && row.name === 'A Grade — verified'));

  const twice = await api(`/api/onboarding/imports/${response.body.id}/apply`, {
    method: 'POST', token: owner, body: {}
  });
  assert.equal(twice.status, 400);
  const history = await api('/api/onboarding/imports', { token: owner });
  assert.equal(history.status, 200);
  assert.ok(history.body.some((batch: any) => batch.id === response.body.id && batch.status === 'applied'));
});

test('global search finds tenant records and returns linked drill-down metadata', async () => {
  const response = await api('/api/global-search?q=Prayag', { token: owner });
  assert.equal(response.status, 200);
  const ledger = response.body.find((row: any) => row.kind === 'ledger');
  assert.ok(ledger);
  assert.equal(ledger.module, 'ledgers');
  assert.equal(ledger.filter, '202');
  assert.match(ledger.title, /Prayag/);
});

test('global search treats SQL wildcard characters as ordinary text', async () => {
  const response = await api('/api/global-search?q=%25%25', { token: owner });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, []);
});
