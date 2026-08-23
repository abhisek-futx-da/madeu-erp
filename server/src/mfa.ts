import bcrypt from 'bcryptjs';
import {
  createCipheriv, createDecipheriv, createHash, createHmac,
  randomBytes, timingSafeEqual
} from 'node:crypto';
import { many, one, withoutTenant, type Db } from './db.ts';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

function encryptionKey() {
  const configured = process.env.MFA_ENCRYPTION_KEY ?? '';
  const key = Buffer.from(configured, 'base64');
  if (key.length !== 32) {
    throw new Error('MFA_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }
  return key;
}

function base32Encode(input: Buffer) {
  let bits = 0; let value = 0; let output = '';
  for (const byte of input) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string) {
  let bits = 0; let value = 0; const bytes: number[] = [];
  for (const char of input.toUpperCase().replace(/=|\s|-/g, '')) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('invalid authenticator secret');
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

function encrypt(secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decrypt(value: string) {
  const [version, iv, tag, encrypted] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('stored MFA secret is unreadable');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}

function sameCode(a: string, b: string) {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function codeForCounter(secret: string, counter: number) {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(counterBytes).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 15;
  const binary = ((digest[offset]! & 127) << 24) |
    (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

/** Exported so the RFC algorithm has deterministic tests, not to bypass MFA. */
export function totpCode(secret: string, now = Date.now()) {
  return codeForCounter(secret, Math.floor(now / 1000 / STEP_SECONDS));
}

const recoveryHash = (code: string) =>
  createHash('sha256').update(code.toUpperCase().replace(/\s/g, '')).digest('hex');

interface MfaRow {
  secret_encrypted: string; recovery_hashes: string[]; enabled_at: string | null; last_counter: number;
}

/** Verifies and consumes a TOTP time-step or one recovery code atomically. */
async function verifySecondFactor(db: Db, userId: string, code: string, allowPending = false) {
  const row = await one<MfaRow>(db,
    'select secret_encrypted, recovery_hashes, enabled_at, last_counter from user_mfa where user_id = $1 for update',
    [userId]);
  if (!row || (!allowPending && !row.enabled_at)) return false;
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) {
    const secret = decrypt(row.secret_encrypted);
    const current = Math.floor(Date.now() / 1000 / STEP_SECONDS);
    for (const counter of [current, current - 1, current + 1]) {
      if (counter <= Number(row.last_counter)) continue;
      if (sameCode(codeForCounter(secret, counter), trimmed)) {
        await db.query('update user_mfa set last_counter = $2 where user_id = $1', [userId, counter]);
        return true;
      }
    }
    return false;
  }

  const wanted = recoveryHash(trimmed);
  const index = row.recovery_hashes.findIndex(hash => sameCode(hash, wanted));
  if (index < 0) return false;
  const remaining = row.recovery_hashes.filter((_, i) => i !== index);
  await db.query('update user_mfa set recovery_hashes = $2 where user_id = $1', [userId, remaining]);
  await db.query("insert into mfa_audit (user_id, event) values ($1, 'recovery_used')", [userId]);
  return true;
}

export async function verifyMfaForLogin(db: Db, userId: string, code?: string) {
  const status = await one<{ enabled: boolean }>(db,
    'select enabled_at is not null as enabled from user_mfa where user_id = $1', [userId]);
  if (!status?.enabled) return { required: false, verified: true };
  if (!code) return { required: true, verified: false };
  return { required: true, verified: await verifySecondFactor(db, userId, code) };
}

export async function mfaStatus(userId: string) {
  return withoutTenant(async db => {
    const row = await one<{ enabled_at: string | null; created_at: string; recovery_codes_left: number }>(db,
      `select enabled_at, created_at, cardinality(recovery_hashes)::int as recovery_codes_left
         from user_mfa where user_id = $1`, [userId]);
    const audit = await many<{ event: string; occurred_at: string }>(db,
      'select event, occurred_at from mfa_audit where user_id = $1 order by occurred_at desc limit 10', [userId]);
    return {
      enabled: !!row?.enabled_at, pending: !!row && !row.enabled_at,
      enabledAt: row?.enabled_at ?? null, recoveryCodesLeft: row?.recovery_codes_left ?? 0, audit
    };
  });
}

export async function beginMfaSetup(userId: string, currentPassword: string) {
  return withoutTenant(async db => {
    const user = await one<{ email: string; password_hash: string }>(db,
      'select email, password_hash from app_user where id = $1', [userId]);
    if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
      throw new Error('current password is incorrect');
    }
    const active = await one<{ enabled: boolean }>(db,
      'select enabled_at is not null as enabled from user_mfa where user_id = $1', [userId]);
    if (active?.enabled) throw new Error('multi-factor authentication is already enabled');

    const secret = base32Encode(randomBytes(20));
    const recoveryCodes = Array.from({ length: 10 }, () => {
      const raw = randomBytes(6).toString('hex').toUpperCase();
      return `${raw.slice(0, 6)}-${raw.slice(6)}`;
    });
    await db.query(
      `insert into user_mfa (user_id, secret_encrypted, recovery_hashes)
       values ($1,$2,$3)
       on conflict (user_id) do update set secret_encrypted = excluded.secret_encrypted,
         recovery_hashes = excluded.recovery_hashes, enabled_at = null, last_counter = -1, created_at = now()`,
      [userId, encrypt(secret), recoveryCodes.map(recoveryHash)]);
    await db.query("insert into mfa_audit (user_id, event) values ($1, 'setup_started')", [userId]);
    const label = encodeURIComponent(user.email);
    const issuer = encodeURIComponent('Link ERP');
    return {
      secret, recoveryCodes,
      otpauthUri: `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`
    };
  });
}

export async function enableMfa(userId: string, code: string) {
  return withoutTenant(async db => {
    const verified = await verifySecondFactor(db, userId, code, true);
    if (!verified) throw new Error('authenticator code is invalid or already used');
    const changed = await db.query(
      'update user_mfa set enabled_at = now() where user_id = $1 and enabled_at is null', [userId]);
    if (changed.rowCount !== 1) throw new Error('start MFA setup before enabling it');
    await db.query("insert into mfa_audit (user_id, event) values ($1, 'enabled')", [userId]);
    return { enabled: true };
  });
}

export async function disableMfa(userId: string, currentPassword: string, code: string) {
  return withoutTenant(async db => {
    const user = await one<{ password_hash: string }>(db,
      'select password_hash from app_user where id = $1', [userId]);
    if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
      throw new Error('current password is incorrect');
    }
    if (!(await verifySecondFactor(db, userId, code))) {
      throw new Error('authenticator or recovery code is invalid or already used');
    }
    await db.query('delete from user_mfa where user_id = $1', [userId]);
    await db.query("insert into mfa_audit (user_id, event) values ($1, 'disabled')", [userId]);
    await db.query('update app_user set session_version = session_version + 1 where id = $1', [userId]);
    return { enabled: false, signInAgain: true };
  });
}
