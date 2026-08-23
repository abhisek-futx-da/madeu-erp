/** Staff access is a financial control.  These tests use the real API and a
 * database built from migrations so a harmless-looking UI change cannot leave
 * a former worker, an old password, or the last-owner rule unprotected. */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {})
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function signIn(email: string, password: string) {
  const response = await call('/auth/login', { method: 'POST', body: { email, password } });
  return response;
}

test('only owners can see company users', async () => {
  const owner = await signIn('owner@neelkamal.test', 'changeme');
  const viewer = await signIn('viewer@neelkamal.test', 'changeme');
  assert.equal(owner.status, 200);
  assert.equal(viewer.status, 200);

  const listed = await call('/users', { token: owner.body.token });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.some((u: { email: string }) => u.email === 'owner@neelkamal.test'));
  assert.ok(!('password_hash' in listed.body[0]), 'password hashes never leave the server');

  const forbidden = await call('/users', { token: viewer.body.token });
  assert.equal(forbidden.status, 403);
});

test('an owner can create, disable, reactivate, and reset a worker without reviving old sessions', async () => {
  const owner = await signIn('owner@neelkamal.test', 'changeme');
  assert.equal(owner.status, 200);
  const stamp = Date.now();
  const email = `worker.${stamp}@neelkamal.test`;
  const temporary = 'TemporaryPass123';
  const replacement = 'ReplacementPass123';

  const weak = await call('/users', {
    method: 'POST', token: owner.body.token,
    body: { email, fullName: 'Pilot Worker', role: 'store', password: 'weak' }
  });
  assert.equal(weak.status, 400);

  const created = await call('/users', {
    method: 'POST', token: owner.body.token,
    body: { email, fullName: 'Pilot Worker', role: 'store', password: temporary }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.role, 'store');

  const firstLogin = await signIn(email, temporary);
  assert.equal(firstLogin.status, 200);
  const oldToken = firstLogin.body.token as string;

  const disabled = await call(`/users/${created.body.id}`, {
    method: 'POST', token: owner.body.token, body: { isActive: false }
  });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  assert.equal(disabled.body.isActive, false);
  const removed = await call('/me', { token: oldToken });
  assert.equal(removed.status, 401, 'disabling access invalidates the old session');

  const reactivated = await call(`/users/${created.body.id}`, {
    method: 'POST', token: owner.body.token, body: { isActive: true, resetPassword: replacement }
  });
  assert.equal(reactivated.status, 200, JSON.stringify(reactivated.body));
  assert.equal(reactivated.body.isActive, true);

  const stale = await signIn(email, temporary);
  assert.equal(stale.status, 401, 'a reset removes the temporary password');
  const fresh = await signIn(email, replacement);
  assert.equal(fresh.status, 200, 'the worker can sign in with the owner-issued replacement');

  const audit = await call('/users/audit', { token: owner.body.token });
  assert.equal(audit.status, 200);
  const events = audit.body.filter((e: { targetName: string }) => e.targetName === 'Pilot Worker')
    .map((e: { event: string }) => e.event);
  assert.deepEqual(events.slice(0, 3), ['password_reset', 'membership_changed', 'membership_disabled']);
});

test('a user changes their own password only after proving the current one', async () => {
  const owner = await signIn('owner@neelkamal.test', 'changeme');
  assert.equal(owner.status, 200);
  const stamp = Date.now();
  const email = `self.${stamp}@neelkamal.test`;
  const oldPassword = 'SelfCurrentPass123';
  const newPassword = 'SelfChangedPass123';
  const created = await call('/users', {
    method: 'POST', token: owner.body.token,
    body: { email, fullName: 'Self Password Worker', role: 'sales', password: oldPassword }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const worker = await signIn(email, oldPassword);
  assert.equal(worker.status, 200);

  const rejected = await call('/auth/password', {
    method: 'POST', token: worker.body.token,
    body: { currentPassword: 'wrong password', newPassword }
  });
  assert.equal(rejected.status, 401);

  const changed = await call('/auth/password', {
    method: 'POST', token: worker.body.token,
    body: { currentPassword: oldPassword, newPassword }
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const oldSession = await call('/me', { token: worker.body.token });
  assert.equal(oldSession.status, 401, 'password change invalidates the pre-change token');
  const newSession = await signIn(email, newPassword);
  assert.equal(newSession.status, 200);
});

test('the final active owner cannot be disabled, demoted, or reset through the owner-reset route', async () => {
  const owner = await signIn('owner@neelkamal.test', 'changeme');
  assert.equal(owner.status, 200);
  const users = await call('/users', { token: owner.body.token });
  const ownerRow = users.body.find((u: { email: string }) => u.email === 'owner@neelkamal.test');
  assert.ok(ownerRow);

  const disabled = await call(`/users/${ownerRow.id}`, {
    method: 'POST', token: owner.body.token, body: { isActive: false }
  });
  assert.equal(disabled.status, 400);
  assert.match(disabled.body.error, /active owner/i);

  const demoted = await call(`/users/${ownerRow.id}`, {
    method: 'POST', token: owner.body.token, body: { role: 'viewer' }
  });
  assert.equal(demoted.status, 400);
  assert.match(demoted.body.error, /active owner/i);

  const resetSelf = await call(`/users/${ownerRow.id}`, {
    method: 'POST', token: owner.body.token, body: { resetPassword: 'AnotherOwnerPass123' }
  });
  assert.equal(resetSelf.status, 400);
  assert.match(resetSelf.body.error, /current-password/i);
});
