import { Router } from 'express';
import { z } from 'zod';
import { many, one, withTenant } from './db.ts';
import {
  clearSessionCookieOptions, hashPassword, login, requireWrite,
  sessionCookieOptions, throttleKey, tooManyAttempts, noteFailure,
  clearAttempts, revokeToken, SESSION_COOKIE, verifyPassword
} from './auth.ts';
import { beginMfaSetup, disableMfa, enableMfa, mfaStatus } from './mfa.ts';

const uuid = z.string().uuid();
const memberRole = z.enum(['owner', 'accounts', 'purchase', 'sales', 'store', 'viewer']);
const strongPassword = z.string().min(12, 'password must be at least 12 characters').max(128)
  .refine(value => /[a-z]/.test(value), 'password must include a lowercase letter')
  .refine(value => /[A-Z]/.test(value), 'password must include an uppercase letter')
  .refine(value => /\d/.test(value), 'password must include a number');

function fyLabel(d = new Date()) {
  const y = d.getFullYear();
  const start = d.getMonth() >= 3 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

export function publicAuthRouter() {
  const router = Router();

  router.post('/auth/login', async (req, res, next) => {
    try {
      const body = z.object({
        email: z.string().email(),
        password: z.string().min(1),
        tenantId: uuid.optional(),
        mfaCode: z.string().trim().min(6).max(32).optional()
      }).parse(req.body);
      const key = throttleKey(body.email, req.ip ?? 'unknown');
      const waitFor = await tooManyAttempts(key);
      if (waitFor !== null) {
        res.setHeader('retry-after', String(waitFor));
        return res.status(429).json({
          error: `too many failed attempts; try again in ${waitFor} seconds`
        });
      }

      const result = await login(body.email, body.password, body.tenantId, body.mfaCode);
      if (!result) {
        await noteFailure(key);
        return res.status(401).json({ error: 'invalid credentials' });
      }
      if ('mfaRequired' in result) {
        res.setHeader('cache-control', 'no-store');
        return res.status(202).json(result);
      }
      await clearAttempts(key);
      // The browser receives an HttpOnly, same-site session.  The legacy token
      // response remains for API compatibility and the test harness; the Link
      // ERP web application deliberately never stores or sends it.
      res.cookie(SESSION_COOKIE, result.token, sessionCookieOptions());
      res.setHeader('cache-control', 'no-store');
      res.json(result);
    } catch (e) { next(e); }
  });

  return router;
}
export function identityRouter() {
  const router = Router();

  router.get('/auth/mfa', async (req, res, next) => {
    try { res.json(await mfaStatus(req.session!.userId)); }
    catch (e) { next(e); }
  });

  router.post('/auth/mfa/setup', async (req, res, next) => {
    try {
      const body = z.object({ currentPassword: z.string().min(1).max(128) }).parse(req.body);
      res.json(await beginMfaSetup(req.session!.userId, body.currentPassword));
    } catch (e) { next(e); }
  });

  router.post('/auth/mfa/enable', async (req, res, next) => {
    try {
      const body = z.object({ code: z.string().trim().min(6).max(32) }).parse(req.body);
      res.json(await enableMfa(req.session!.userId, body.code));
    } catch (e) { next(e); }
  });

  router.post('/auth/mfa/disable', async (req, res, next) => {
    try {
      const body = z.object({
        currentPassword: z.string().min(1).max(128),
        code: z.string().trim().min(6).max(32)
      }).parse(req.body);
      res.json(await disableMfa(req.session!.userId, body.currentPassword, body.code));
    } catch (e) { next(e); }
  });

  router.post('/auth/logout', async (req, res, next) => {
    try {
      if (req.session?.jti) await revokeToken(req.session.jti);
      res.clearCookie(SESSION_COOKIE, clearSessionCookieOptions());
      res.setHeader('cache-control', 'no-store');
      res.json({ signedOut: true });
    } catch (e) { next(e); }
  });

  router.get('/me', async (req, res, next) => {
    try {
      const { tenantId, userId, role } = req.session!;
      const [tenant, user] = await withTenant(tenantId, userId, async db => {
        const tenant = await one<{ legal_name: string; gstin: string; fy_start: string }>(
          db, 'select legal_name, gstin, fy_start from tenant where id = $1', [tenantId]);
        const user = await one<{ email: string; full_name: string }>(
          db, 'select email, full_name from app_user where id = $1', [userId]);
        return [tenant, user] as const;
      });
      res.json({
        userId, tenantId, role,
        user: user ? { email: user.email, fullName: user.full_name } : null,
        tenant: tenant
          ? { legalName: tenant.legal_name, gstin: tenant.gstin, fyLabel: fyLabel(new Date(tenant.fy_start)) }
          : null
      });
    } catch (e) { next(e); }
  });

  // ------------------------------------------------------ people & access --

  /**
   * A password is global to a person, whereas their authority is scoped to a
   * company.  These routes deliberately keep those two concerns separate: an
   * owner can remove a worker from this company without disabling an account
   * the worker may legitimately use at another tenant.
   */
  router.get('/users', requireWrite('owner'), async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session!;
      const users = await withTenant(tenantId, userId, db => many<{
        id: string; email: string; full_name: string; role: string;
        is_active: boolean; created_at: string; mfa_enabled: boolean;
      }>(db,
        `select u.id, u.email, u.full_name, m.role::text, m.is_active, u.created_at,
                coalesce(um.enabled_at is not null, false) as mfa_enabled
           from membership m join app_user u on u.id = m.user_id
           left join user_mfa um on um.user_id = u.id
          where m.tenant_id = $1
          order by m.is_active desc, m.role = 'owner' desc, lower(u.full_name), u.email`,
        [tenantId]
      ));
      res.json(users.map(u => ({
        id: u.id, email: u.email, fullName: u.full_name, role: u.role,
        isActive: u.is_active, createdAt: u.created_at, mfaEnabled: u.mfa_enabled
      })));
    } catch (e) { next(e); }
  });

  router.get('/users/audit', requireWrite('owner'), async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db => many<{
        id: number; event: string; details: unknown; occurred_at: string;
        actor_name: string | null; target_name: string | null;
      }>(db,
        `select a.id, a.event, a.details, a.occurred_at,
                actor.full_name as actor_name, target.full_name as target_name
           from access_audit a
           left join app_user actor on actor.id = a.actor_id
           left join app_user target on target.id = a.target_user_id
          where a.tenant_id = $1
          order by a.occurred_at desc, a.id desc
          limit 100`,
        [tenantId]
      ));
      res.json(rows.map(r => ({
        id: r.id, event: r.event, details: r.details, occurredAt: r.occurred_at,
        actorName: r.actor_name, targetName: r.target_name
      })));
    } catch (e) { next(e); }
  });

  router.post('/users', requireWrite('owner'), async (req, res, next) => {
    try {
      const body = z.object({
        email: z.string().email().max(254),
        fullName: z.string().trim().min(2).max(120),
        role: memberRole,
        password: strongPassword
      }).parse(req.body);
      const { tenantId, userId } = req.session!;
      const passwordHash = await hashPassword(body.password);
      const created = await withTenant(tenantId, userId, async db => {
        const exists = await one<{ id: string }>(db,
          'select id from app_user where email = $1', [body.email.toLowerCase()]);
        if (exists) throw new Error('an account with this email already exists; do not share a person between companies until invitations are implemented');
        const user = await one<{ id: string; email: string; full_name: string }>(db,
          `insert into app_user (email, full_name, password_hash)
           values ($1, $2, $3) returning id, email, full_name`,
          [body.email.toLowerCase(), body.fullName, passwordHash]
        );
        if (!user) throw new Error('user creation returned nothing');
        await db.query(
          `insert into membership (tenant_id, user_id, role, is_active)
           values ($1, $2, $3::member_role, true)`,
          [tenantId, user.id, body.role]
        );
        await db.query(
          `insert into access_audit (tenant_id, actor_id, target_user_id, event, details)
           values ($1, $2, $3, 'user_created', jsonb_build_object('role', $4::text))`,
          [tenantId, userId, user.id, body.role]
        );
        return user;
      });
      res.status(201).json({
        id: created.id, email: created.email, fullName: created.full_name,
        role: body.role, isActive: true
      });
    } catch (e) { next(e); }
  });

  router.post('/users/:userId', requireWrite('owner'), async (req, res, next) => {
    try {
      const body = z.object({
        role: memberRole.optional(),
        isActive: z.boolean().optional(),
        resetPassword: strongPassword.optional()
      }).refine(value => value.role !== undefined || value.isActive !== undefined || value.resetPassword !== undefined,
        'choose a role, an access state, or a password reset').parse(req.body);
      const targetId = uuid.parse(req.params.userId);
      const { tenantId, userId } = req.session!;
      if (targetId === userId && body.resetPassword) {
        throw new Error('change your own password with the password screen; an owner reset cannot replace the current-password check');
      }
      const passwordHash = body.resetPassword ? await hashPassword(body.resetPassword) : null;
      const updated = await withTenant(tenantId, userId, async db => {
        const before = await one<{ id: string; email: string; full_name: string; role: string; is_active: boolean }>(db,
          `select u.id, u.email, u.full_name, m.role::text, m.is_active
             from membership m join app_user u on u.id = m.user_id
            where m.tenant_id = $1 and m.user_id = $2`,
          [tenantId, targetId]
        );
        if (!before) throw new Error('user is not a member of this company');

        if (body.role !== undefined || body.isActive !== undefined) {
          await db.query(
            `update membership
                set role = coalesce($3::member_role, role),
                    is_active = coalesce($4::boolean, is_active)
              where tenant_id = $1 and user_id = $2`,
            [tenantId, targetId, body.role ?? null, body.isActive ?? null]
          );
        }
        if (passwordHash) {
          await db.query(
            `update app_user set password_hash = $2, session_version = session_version + 1
              where id = $1`, [targetId, passwordHash]
          );
        }
        // Re-activating a worker must not resurrect the browser token that was
        // valid before their access was removed.  Session versions are global
        // to an identity, so they must sign in again to every company.
        if (body.isActive === false && !passwordHash) {
          await db.query(
            'update app_user set session_version = session_version + 1 where id = $1',
            [targetId]
          );
        }
        const after = await one<{ id: string; email: string; full_name: string; role: string; is_active: boolean }>(db,
          `select u.id, u.email, u.full_name, m.role::text, m.is_active
             from membership m join app_user u on u.id = m.user_id
            where m.tenant_id = $1 and m.user_id = $2`,
          [tenantId, targetId]
        );
        if (!after) throw new Error('user update returned nothing');
        if (body.role !== undefined || body.isActive !== undefined) {
          await db.query(
            `insert into access_audit (tenant_id, actor_id, target_user_id, event, details)
             values ($1, $2, $3, $4, jsonb_build_object(
               'from_role', $5::text, 'to_role', $6::text,
               'from_active', $7::boolean, 'to_active', $8::boolean))`,
            [tenantId, userId, targetId,
             after.is_active ? 'membership_changed' : 'membership_disabled',
             before.role, after.role, before.is_active, after.is_active]
          );
        }
        if (passwordHash) {
          await db.query(
            `insert into access_audit (tenant_id, actor_id, target_user_id, event)
             values ($1, $2, $3, 'password_reset')`,
            [tenantId, userId, targetId]
          );
        }
        return after;
      });
      res.json({
        id: updated.id, email: updated.email, fullName: updated.full_name,
        role: updated.role, isActive: updated.is_active
      });
    } catch (e) { next(e); }
  });

  router.post('/users/:userId/mfa-reset', requireWrite('owner'), async (req, res, next) => {
    try {
      const targetId = uuid.parse(req.params.userId);
      const body = z.object({
        currentPassword: z.string().min(1).max(128),
        reason: z.string().trim().min(10).max(300)
      }).parse(req.body);
      const { tenantId, userId } = req.session!;
      if (targetId === userId) throw new Error('disable your own MFA from My Password using your second factor');
      await withTenant(tenantId, userId, async db => {
        const actor = await one<{ password_hash: string }>(db,
          'select password_hash from app_user where id = $1', [userId]);
        if (!actor || !(await verifyPassword(body.currentPassword, actor.password_hash))) {
          throw new Error('current owner password is incorrect');
        }
        const member = await one<{ exists: boolean }>(db,
          'select true as exists from membership where tenant_id = $1 and user_id = $2', [tenantId, targetId]);
        if (!member) throw new Error('user is not a member of this company');
        const removed = await db.query('delete from user_mfa where user_id = $1', [targetId]);
        if (removed.rowCount !== 1) throw new Error('this user does not have MFA enabled');
        await db.query("insert into mfa_audit (user_id, event) values ($1, 'admin_reset')", [targetId]);
        await db.query('update app_user set session_version = session_version + 1 where id = $1', [targetId]);
        await db.query(
          `insert into access_audit (tenant_id, actor_id, target_user_id, event, details)
           values ($1,$2,$3,'mfa_reset',jsonb_build_object('reason',$4::text))`,
          [tenantId, userId, targetId, body.reason]);
      });
      res.json({ reset: true });
    } catch (e) { next(e); }
  });

  router.post('/auth/password', async (req, res, next) => {
    try {
      const body = z.object({ currentPassword: z.string().min(1), newPassword: strongPassword }).parse(req.body);
      const { tenantId, userId } = req.session!;
      const current = await withTenant(tenantId, userId, db => one<{
        email: string; password_hash: string;
      }>(db, 'select email, password_hash from app_user where id = $1', [userId]));
      if (!current || !await verifyPassword(body.currentPassword, current.password_hash)) {
        return res.status(401).json({ error: 'current password is incorrect' });
      }
      await withTenant(tenantId, userId, async db => {
        await db.query(
          `update app_user set password_hash = $2, session_version = session_version + 1
            where id = $1`, [userId, await hashPassword(body.newPassword)]
        );
        await db.query(
          `insert into access_audit (tenant_id, actor_id, target_user_id, event)
           values ($1, $2, $2, 'password_changed')`,
          [tenantId, userId]
        );
      });
      const fresh = await login(current.email, body.newPassword, tenantId, undefined, true);
      if (!fresh || 'mfaRequired' in fresh) throw new Error('could not establish the new session');
      res.cookie(SESSION_COOKIE, fresh.token, sessionCookieOptions());
      res.setHeader('cache-control', 'no-store');
      res.json({ passwordChanged: true });
    } catch (e) { next(e); }
  });


  return router;
}
