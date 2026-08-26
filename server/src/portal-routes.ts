import { Router } from 'express';
import { z } from 'zod';
import {
  portalLogin, requirePortalAuth, withPortal, portalReads, fileDeclaration
} from './portal.ts';
import { throttleKey, tooManyAttempts, noteFailure, clearAttempts, revokeToken } from './auth.ts';

/**
 * Everything a process house can reach, mounted well away from the mill's own
 * API. Separate router, separate middleware, separate token audience: there is
 * no path from here into a staff endpoint, and none from a staff token to here.
 */

const barcode = z.string().trim().min(1).max(40);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export function buildPortalRoutes() {
  const portal = Router();

  portal.post('/auth/login', async (req, res, next) => {
    try {
      const body = z.object({
        email: z.string().email(),
        password: z.string().min(1),
        tenantId: z.string().uuid().optional()
      }).parse(req.body);

      // The same durable throttle the mill's own login uses; an outside login
      // is the one most likely to be guessed at from the internet.
      const key = throttleKey(`portal:${body.email}`, req.ip ?? 'unknown');
      const waitFor = await tooManyAttempts(key);
      if (waitFor !== null) {
        res.setHeader('retry-after', String(waitFor));
        return res.status(429).json({
          error: `too many failed attempts; try again in ${waitFor} seconds`
        });
      }

      const out = await portalLogin(body.email, body.password, body.tenantId);
      if (!out) {
        await noteFailure(key);
        return res.status(401).json({ error: 'invalid credentials' });
      }
      await clearAttempts(key);
      res.json(out);
    } catch (e) { next(e); }
  });

  portal.use(requirePortalAuth);

  portal.post('/auth/logout', async (req, res, next) => {
    try {
      if (req.portal?.jti) await revokeToken(req.portal.jti);
      res.json({ signedOut: true });
    } catch (e) { next(e); }
  });

  portal.get('/me', (req, res) => {
    const s = req.portal!;
    res.json({ userId: s.userId, tenantId: s.tenantId, partyId: s.partyId, kind: 'process_house' });
  });

  portal.get('/challans', async (req, res, next) => {
    try { res.json(await withPortal(req, portalReads.challans)); } catch (e) { next(e); }
  });

  portal.get('/pieces', async (req, res, next) => {
    try { res.json(await withPortal(req, portalReads.pieces)); } catch (e) { next(e); }
  });

  portal.get('/declarations', async (req, res, next) => {
    try { res.json(await withPortal(req, portalReads.declarations)); } catch (e) { next(e); }
  });

  portal.post('/declarations', async (req, res, next) => {
    try {
      const body = z.object({
        kind: z.enum(['custody_ack', 'shortage', 'rejection', 'expected_return', 'return_dispatch']),
        issueId: z.string().uuid().nullish(),
        theirRef: z.string().max(50).default(''),
        vehicleNo: z.string().max(30).nullish(),
        expectedOn: isoDate.nullish(),
        note: z.string().max(500).default(''),
        lines: z.array(z.object({
          barcode,
          qty: z.coerce.number().finite().nonnegative().nullish(),
          reason: z.string().max(200).optional()
        })).max(1000).optional()
      }).parse(req.body);
      res.status(201).json(await fileDeclaration(req, body));
    } catch (e) { next(e); }
  });

  /**
   * The portal ends here. Without this, an unknown portal path falls through
   * into the mill's own router, where a staff-only guard answers instead — the
   * request is still refused, but an outside caller learns which mill endpoints
   * exist by reading the difference between the two refusals.
   */
  portal.use((req, res) => {
    res.status(404).json({ error: `no such endpoint: ${req.method} ${req.path}` });
  });

  return portal;
}
