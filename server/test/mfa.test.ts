import test from 'node:test';
import assert from 'node:assert/strict';
import { totpCode } from '../src/mfa.ts';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const stamp = Date.now();
const email = `mfa-${stamp}@neelkamal.test`;
const password = 'StrongPilot123';
let owner = '';
let worker = '';
let workerId = '';
let secret = '';
let recovery: string[] = [];

async function api(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('create a named pilot user for MFA', async () => {
  const signed = await api('/api/auth/login', {
    method: 'POST', body: { email: 'owner@neelkamal.test', password: 'changeme' }
  });
  assert.equal(signed.status, 200);
  owner = signed.body.token;
  const created = await api('/api/users', {
    method: 'POST', token: owner,
    body: { email, fullName: 'MFA Pilot User', role: 'accounts', password }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  workerId = created.body.id;
  const login = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(login.status, 200);
  worker = login.body.token;
});

test('setup requires the current password and returns one-time recovery material', async () => {
  const refused = await api('/api/auth/mfa/setup', {
    method: 'POST', token: worker, body: { currentPassword: 'wrong' }
  });
  assert.equal(refused.status, 400);

  const setup = await api('/api/auth/mfa/setup', {
    method: 'POST', token: worker, body: { currentPassword: password }
  });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.body.otpauthUri, /^otpauth:\/\/totp\//);
  assert.equal(setup.body.recoveryCodes.length, 10);
  secret = setup.body.secret;
  recovery = setup.body.recoveryCodes;
});

test('a current authenticator code enables MFA and cannot be replayed', async () => {
  const bad = await api('/api/auth/mfa/enable', {
    method: 'POST', token: worker, body: { code: '000000' }
  });
  assert.equal(bad.status, 400);

  const enabled = await api('/api/auth/mfa/enable', {
    method: 'POST', token: worker, body: { code: totpCode(secret) }
  });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));

  const status = await api('/api/auth/mfa', { token: worker });
  assert.equal(status.body.enabled, true);
  assert.equal(status.body.recoveryCodesLeft, 10);

  const needsMfa = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(needsMfa.status, 202);
  assert.equal(needsMfa.body.mfaRequired, true);

  const replay = await api('/api/auth/login', {
    method: 'POST', body: { email, password, mfaCode: totpCode(secret) }
  });
  assert.equal(replay.status, 401, 'the code consumed at enable must not open another session');
});

test('a recovery code is one-time and can open a fully authorised session', async () => {
  const recovered = await api('/api/auth/login', {
    method: 'POST', body: { email, password, mfaCode: recovery[0] }
  });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  worker = recovered.body.token;
  const usedAgain = await api('/api/auth/login', {
    method: 'POST', body: { email, password, mfaCode: recovery[0] }
  });
  assert.equal(usedAgain.status, 401);
  const status = await api('/api/auth/mfa', { token: worker });
  assert.equal(status.body.recoveryCodesLeft, 9);
  assert.equal(status.body.audit[0].event, 'recovery_used');
});

test('owner can see MFA readiness and lost-device reset is password-gated and audited', async () => {
  const users = await api('/api/users', { token: owner });
  const user = users.body.find((row: any) => row.id === workerId);
  assert.equal(user.mfaEnabled, true);

  const wrong = await api(`/api/users/${workerId}/mfa-reset`, {
    method: 'POST', token: owner, body: { currentPassword: 'wrong', reason: 'lost company handset' }
  });
  assert.equal(wrong.status, 400);
  const reset = await api(`/api/users/${workerId}/mfa-reset`, {
    method: 'POST', token: owner, body: { currentPassword: 'changeme', reason: 'lost company handset' }
  });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));

  const revoked = await api('/api/me', { token: worker });
  assert.equal(revoked.status, 401);
  const withoutMfa = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(withoutMfa.status, 200);
});
