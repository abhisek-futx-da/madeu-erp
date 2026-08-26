import type { CookieOptions, NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { one, withoutTenant } from './db.ts';
import { verifyMfaForLogin } from './mfa.ts';

const SECRET = process.env.JWT_SECRET ?? '';
if (!SECRET) throw new Error('JWT_SECRET must be set');
const KEY_ID = process.env.JWT_KEY_ID?.trim() || 'current';
const PREVIOUS_SECRETS = (process.env.JWT_PREVIOUS_SECRETS ?? '')
  .split(',').map(value => value.trim()).filter(Boolean);
const VERIFY_SECRETS = [SECRET, ...PREVIOUS_SECRETS.filter(value => value !== SECRET)];

export type Role = 'owner' | 'accounts' | 'purchase' | 'sales' | 'store' | 'viewer';
export type Permission =
  'write:masters' | 'write:purchase' | 'write:store' |
  'write:sales' | 'write:accounts' | 'write:owner';

export interface Session {
  userId: string;
  tenantId: string;
  role: Role;
  /** Re-read from the assigned tenant profile on every request. */
  permissions?: Permission[];
  /** The business location selected for this company membership. */
  activeLocationId?: string;
  /** Token id, so a single session can be revoked before it expires. */
  jti?: string;
  /** Password changes and administrator resets invalidate every old session. */
  sv?: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: Session;
      /** Correlates a browser/API failure with the single structured log line. */
      requestId?: string;
    }
  }
}

export const hashPassword = (plain: string) => bcrypt.hash(plain, 12);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

/**
 * Login throttling and token revocation. Both used to be a Map and a Set in
 * process memory, which meant a restart resurrected every signed-out token and
 * a second instance kept its own counters. They live in the database now, so
 * the guarantee holds across restarts and across instances.
 *
 * Keyed on email and source IP so one attacker cannot lock out a legitimate
 * user by guessing at their address.
 */
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 8;
const TOKEN_TTL_MS = 12 * 3_600_000;
export const SESSION_COOKIE = 'link_erp_session';

/** Browser sessions use an HttpOnly cookie.  The API also accepts Bearer
 * credentials for command-line integrations and the isolated test harness,
 * but the web application never needs to keep a stealable token in storage. */
export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.FORCE_HTTPS === 'true',
    sameSite: 'strict',
    path: '/',
    maxAge: TOKEN_TTL_MS
  };
}

export function clearSessionCookieOptions(): CookieOptions {
  const { maxAge: _maxAge, ...options } = sessionCookieOptions();
  return options;
}

function cookieToken(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name !== SESSION_COOKIE || value.length === 0) continue;
    try { return decodeURIComponent(value.join('=')); } catch { return null; }
  }
  return null;
}

function requestToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return cookieToken(req.headers.cookie);
}

export function throttleKey(email: string, ip: string) {
  return `${email.toLowerCase()}|${ip}`;
}

export async function tooManyAttempts(key: string): Promise<number | null> {
  return withoutTenant(async db => {
    const rec = await one<{ attempts: number; age_ms: number }>(
      db,
      `select attempts, extract(epoch from (now() - first_at)) * 1000 as age_ms
         from login_attempt where attempt_key = $1`,
      [key]
    );
    if (!rec) return null;
    if (Number(rec.age_ms) > WINDOW_MS) {
      await db.query('delete from login_attempt where attempt_key = $1', [key]);
      return null;
    }
    if (rec.attempts < MAX_ATTEMPTS) return null;
    return Math.ceil((WINDOW_MS - Number(rec.age_ms)) / 1000);
  });
}

export async function noteFailure(key: string) {
  await withoutTenant(db =>
    db.query(
      `insert into login_attempt (attempt_key) values ($1)
       on conflict (attempt_key) do update
         set attempts = case when now() - login_attempt.first_at > $2::interval
                             then 1 else login_attempt.attempts + 1 end,
             first_at = case when now() - login_attempt.first_at > $2::interval
                             then now() else login_attempt.first_at end,
             last_at  = now()`,
      [key, `${WINDOW_MS} milliseconds`]
    )
  );
}

export async function clearAttempts(key: string) {
  await withoutTenant(db => db.query('delete from login_attempt where attempt_key = $1', [key]));
}

/** A logged-out or compromised token must stop working before it expires. */
export async function revokeToken(jti: string) {
  await withoutTenant(db =>
    db.query(
      `insert into revoked_token (jti, expires_at) values ($1, now() + $2::interval)
       on conflict (jti) do nothing`,
      [jti, `${TOKEN_TTL_MS} milliseconds`]
    )
  );
}

export async function isRevoked(jti: string): Promise<boolean> {
  const row = await withoutTenant(db =>
    one<{ ok: boolean }>(db, 'select true as ok from revoked_token where jti = $1', [jti])
  );
  return row !== null;
}

/** Rows past their expiry prove nothing: the token they name is dead anyway. */
export async function pruneAuthState() {
  await withoutTenant(async db => {
    await db.query('delete from revoked_token where expires_at < now()');
    await db.query(
      'delete from login_attempt where first_at < now() - $1::interval',
      [`${WINDOW_MS} milliseconds`]
    );
  });
}

export async function login(
  email: string, password: string, tenantId?: string, mfaCode?: string,
  mfaAlreadyVerified = false
) {
  return withoutTenant(async db => {
    const user = await one<{ id: string; password_hash: string; is_active: boolean; session_version: number }>(
      db,
      'select id, password_hash, is_active, session_version from app_user where email = $1',
      [email]
    );
    // Compare regardless, so a missing user and a wrong password take the same time.
    const ok = await verifyPassword(password, user?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali');
    if (!user || !user.is_active || !ok) return null;

    const mfa = mfaAlreadyVerified
      ? { required: false, verified: true }
      : await verifyMfaForLogin(db, user.id, mfaCode);
    if (mfa.required && !mfa.verified) {
      // Asking for the second factor is safe only after the password was
      // correct. A wrong or replayed code remains indistinguishable from bad
      // credentials and is counted by the caller's durable throttle.
      return mfaCode ? null : { mfaRequired: true as const };
    }

    const memberships = await db.query(
      'select tenant_id, role, legal_name from user_memberships($1)',
      [user.id]
    );
    if (memberships.rowCount === 0) return null;

    const chosen = tenantId
      ? memberships.rows.find(r => r.tenant_id === tenantId)
      : memberships.rows[0];
    if (!chosen) return null;

    const jti = crypto.randomUUID();
    const token = jwt.sign(
      { userId: user.id, tenantId: chosen.tenant_id, role: chosen.role, jti, sv: user.session_version },
      SECRET,
      { expiresIn: '12h', keyid: KEY_ID }
    );
    return { token, tenant: chosen.legal_name, role: chosen.role as Role, tenants: memberships.rows };
  });
}

/**
 * A token is not the last word on what its bearer may do. Role, membership and
 * whether the account is still active are re-read on every request, so
 * deactivating a user or demoting them takes effect immediately rather than
 * when their twelve hours happen to run out.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = requestToken(req);
  if (!token) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }

  let claims: Session;
  let verified: Session | null = null;
  for (const secret of VERIFY_SECRETS) {
    try {
      verified = jwt.verify(token, secret) as Session;
      break;
    } catch {
      // During a planned rotation, tokens signed by the immediately previous
      // key remain valid until their ordinary twelve-hour expiry.
    }
  }
  if (!verified) {
    res.status(401).json({ error: 'invalid or expired token' });
    return;
  }
  claims = verified;

  // A process-house token opens the portal and nothing else. Without this the
  // outside login would inherit whatever the staff routes allow.
  if ((claims as { aud?: string }).aud === 'portal') {
    res.status(403).json({ error: 'a process-house sign-in cannot use the mill application' });
    return;
  }

  try {
    const state = await withoutTenant(db =>
      one<{
        is_active: boolean; session_version: number; role: Role | null;
        permissions: Permission[] | null; active_location_id: string | null; revoked: boolean;
      }>(
        db,
        `select u.is_active, u.session_version, s.role, s.permissions, s.active_location_id,
                exists (select 1 from revoked_token where jti = $3::uuid) as revoked
           from app_user u
           left join lateral user_membership_state($1,$2) s on true
          where u.id = $1`,
        [claims.userId, claims.tenantId, claims.jti ?? null]
      )
    );

    if (!state) {
      res.status(401).json({ error: 'this account no longer exists' });
      return;
    }
    if (state.revoked) {
      res.status(401).json({ error: 'this session has been signed out' });
      return;
    }
    if (!state.is_active) {
      res.status(401).json({ error: 'this account has been deactivated' });
      return;
    }
    if (state.session_version !== claims.sv) {
      res.status(401).json({ error: 'this session is no longer valid; please sign in again' });
      return;
    }
    if (!state.role) {
      res.status(403).json({ error: 'no longer a member of this company' });
      return;
    }

    req.session = {
      ...claims, role: state.role,
      permissions: state.permissions ?? [],
      activeLocationId: state.active_location_id ?? undefined
    };
    next();
  } catch (err) {
    next(err);
  }
}

const WRITERS: Record<string, Role[]> = {
  masters: ['owner', 'accounts', 'purchase', 'sales'],
  purchase: ['owner', 'purchase'],
  store: ['owner', 'store', 'purchase'],
  sales: ['owner', 'sales'],
  accounts: ['owner', 'accounts'],
  owner: ['owner']
};

/** Authorisation lives here, not in the UI — the UI only hides what it hides. */
export function requireWrite(area: keyof typeof WRITERS) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.session?.role;
    const permissions = req.session?.permissions;
    const allowed = permissions
      ? permissions.includes(`write:${area}` as Permission)
      : Boolean(role && WRITERS[area]?.includes(role));
    if (!allowed) {
      res.status(403).json({ error: `role ${role ?? 'none'} cannot write ${area}` });
      return;
    }
    next();
  };
}
