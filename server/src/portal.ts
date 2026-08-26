import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { many, one, withParty, withoutTenant, type Db } from './db.ts';
import { verifyPassword, hashPassword } from './auth.ts';

/**
 * The process-house portal: an outside login that can see its own custody and
 * say things about it, and can do nothing else.
 *
 * Three rules hold everywhere in this file.
 *
 *  - A portal session never writes to `piece`, `piece_movement` or any ledger.
 *    It files declarations; the mill's own staff accept them. An outside party
 *    that could move stock would be a hole in the spine, not a feature.
 *  - The party is read from the verified token and set on the connection. No
 *    endpoint takes a party from the caller, so no caller can name another.
 *  - A staff token is refused here and a portal token is refused everywhere
 *    else. The two audiences never overlap.
 */

const SECRET = process.env.JWT_SECRET ?? '';
const PREVIOUS = (process.env.JWT_PREVIOUS_SECRETS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);
const VERIFY_SECRETS = [SECRET, ...PREVIOUS.filter(v => v !== SECRET)];

/** The claim that separates the two populations of token. */
export const PORTAL_AUDIENCE = 'portal';

export interface PortalSession {
  userId: string;
  tenantId: string;
  partyId: string;
  aud: typeof PORTAL_AUDIENCE;
  jti?: string;
  sv?: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      portal?: PortalSession;
    }
  }
}

// ------------------------------------------------------------------ login --

export async function portalLogin(email: string, password: string, tenantId?: string) {
  return withoutTenant(async db => {
    const user = await one<{
      id: string; password_hash: string; is_active: boolean; session_version: number;
    }>(
      db,
      'select id, password_hash, is_active, session_version from app_user where email = $1',
      [email]
    );
    // Compared regardless, so an unknown address and a wrong password cost the
    // same time and cannot be told apart.
    const ok = await verifyPassword(
      password,
      user?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali'
    );
    if (!user || !user.is_active || !ok) return null;

    const rows = await many<{
      tenant_id: string; party_id: string; legal_name: string; party_name: string;
    }>(db, 'select * from portal_membership($1)', [user.id]);
    if (rows.length === 0) return null;

    const chosen = tenantId ? rows.find(r => r.tenant_id === tenantId) : rows[0];
    if (!chosen) return null;

    const jti = crypto.randomUUID();
    const token = jwt.sign(
      {
        userId: user.id, tenantId: chosen.tenant_id, partyId: chosen.party_id,
        aud: PORTAL_AUDIENCE, jti, sv: user.session_version
      },
      SECRET,
      { expiresIn: '12h' }
    );
    return {
      token, mill: chosen.legal_name, party: chosen.party_name,
      companies: rows.map(r => ({ tenantId: r.tenant_id, mill: r.legal_name, party: r.party_name }))
    };
  });
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

/**
 * Whether the portal account still exists, is still active, still belongs to
 * this party and has not been signed out — re-read on every request, so
 * revoking a process house's access takes effect at once rather than whenever
 * its token happens to expire.
 */
export async function requirePortalAuth(req: Request, res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }

  let claims: PortalSession | null = null;
  for (const secret of VERIFY_SECRETS) {
    try {
      claims = jwt.verify(token, secret) as PortalSession;
      break;
    } catch { /* a rotated key still verifies until its ordinary expiry */ }
  }
  if (!claims) {
    res.status(401).json({ error: 'invalid or expired token' });
    return;
  }
  // A staff token must not open the portal, whatever else it is allowed to do.
  if (claims.aud !== PORTAL_AUDIENCE || !claims.partyId) {
    res.status(403).json({ error: 'this sign-in is not a process-house account' });
    return;
  }

  try {
    const state = await withoutTenant(db =>
      one<{ is_active: boolean; session_version: number; bound: boolean; revoked: boolean }>(
        db,
        // Through definer functions, not the tables: this runs before a tenant
        // is set on the connection, and `party_portal_user` is behind RLS.
        `select u.is_active, u.session_version,
                portal_binding($1, $2, $3) as bound,
                exists (select 1 from revoked_token where jti = $4::uuid) as revoked
           from app_user u where u.id = $1`,
        [claims.userId, claims.tenantId, claims.partyId, claims.jti ?? null]
      )
    );
    if (!state) return void res.status(401).json({ error: 'this account no longer exists' });
    if (state.revoked) return void res.status(401).json({ error: 'this session has been signed out' });
    if (!state.is_active) return void res.status(401).json({ error: 'this account has been deactivated' });
    if (state.session_version !== claims.sv) {
      return void res.status(401).json({ error: 'this session is no longer valid; please sign in again' });
    }
    if (!state.bound) {
      return void res.status(403).json({ error: 'this account no longer works for that company' });
    }

    req.portal = claims;
    next();
  } catch (err) {
    next(err);
  }
}

/** Every portal read and write runs through here, with the party pinned. */
export function withPortal<T>(req: Request, fn: (db: Db) => Promise<T>): Promise<T> {
  const s = req.portal!;
  return withParty(s.tenantId, s.partyId, s.userId, fn);
}

// ----------------------------------------------------------- what they see --

export const portalReads = {
  challans: (db: Db) => many(
    db,
    `select * from v_portal_challan
      order by acknowledged_at is not null, challan_date desc, entry_no desc limit 500`
  ),
  pieces: (db: Db) => many(
    db, 'select * from v_portal_piece order by challan_no, barcode limit 2000'
  ),
  declarations: (db: Db) => many(
    db, 'select * from v_portal_declaration order by declared_at desc limit 500'
  )
};

// --------------------------------------------------------- what they say --

export type DeclarationKind =
  'custody_ack' | 'shortage' | 'rejection' | 'expected_return' | 'return_dispatch';

export interface DeclarationInput {
  kind: DeclarationKind;
  issueId?: string | null;
  theirRef?: string;
  vehicleNo?: string | null;
  expectedOn?: string | null;
  note?: string;
  lines?: { barcode: string; qty?: number | null; reason?: string }[];
}

/** Which declarations are about specific thaans, and must therefore name them. */
const NEEDS_LINES = new Set<DeclarationKind>(['shortage', 'rejection', 'return_dispatch']);
const NEEDS_ISSUE = new Set<DeclarationKind>(['custody_ack', 'shortage', 'expected_return']);

export async function fileDeclaration(req: Request, input: DeclarationInput) {
  const s = req.portal!;
  return withPortal(req, async db => {
    // The challan must be one of theirs. Reading it through the portal view
    // means a challan belonging to another process house simply is not found.
    let issueId: string | null = null;
    if (input.issueId) {
      const mine = await one<{ issue_id: string }>(
        db, 'select issue_id from v_portal_challan where issue_id = $1 limit 1', [input.issueId]
      );
      if (!mine) throw new Error('that challan is not one of yours');
      issueId = mine.issue_id;
    }
    if (NEEDS_ISSUE.has(input.kind) && !issueId) {
      throw new Error(`a ${input.kind.replace(/_/g, ' ')} has to name the challan it is about`);
    }

    const lines = (input.lines ?? [])
      .map(l => ({ ...l, barcode: l.barcode.trim() }))
      .filter(l => l.barcode.length > 0);
    if (NEEDS_LINES.has(input.kind) && lines.length === 0) {
      throw new Error(`a ${input.kind.replace(/_/g, ' ')} has to name the thaans it is about`);
    }
    if (input.kind === 'expected_return' && !input.expectedOn) {
      throw new Error('give the date you expect to return the goods');
    }

    // Only barcodes actually in this party's custody. Anything else is either a
    // typo or an attempt to speak about goods they are not holding.
    let resolved: { barcode: string; piece_id: string }[] = [];
    if (lines.length > 0) {
      resolved = await many<{ barcode: string; piece_id: string }>(
        db,
        'select barcode, piece_id from v_portal_piece where barcode = any($1::text[])',
        [lines.map(l => l.barcode)]
      );
      const known = new Set(resolved.map(r => r.barcode));
      const strangers = lines.filter(l => !known.has(l.barcode));
      if (strangers.length > 0) {
        throw new Error(
          `not in your custody: ${strangers.slice(0, 5).map(l => l.barcode).join(', ')}`
        );
      }
    }

    const declaration = await one<{ id: string }>(
      db,
      `insert into party_declaration (tenant_id, party_id, kind, issue_id, their_ref,
                                      vehicle_no, expected_on, note, declared_by)
       values ($1,$2,$3::declaration_kind,$4,$5,$6,$7,$8,$9) returning id`,
      [s.tenantId, s.partyId, input.kind, issueId, (input.theirRef ?? '').trim(),
       input.vehicleNo ?? null, input.expectedOn ?? null, (input.note ?? '').trim(), s.userId]
    );
    if (!declaration) throw new Error('declaration insert returned nothing');

    if (lines.length > 0) {
      const byBarcode = new Map(resolved.map(r => [r.barcode, r.piece_id]));
      await db.query(
        `insert into party_declaration_line (tenant_id, declaration_id, piece_id, barcode, qty, reason)
         select $1, $2, x.piece_id, x.barcode, x.qty, x.reason
           from unnest($3::uuid[], $4::text[], $5::numeric[], $6::text[])
                as x(piece_id, barcode, qty, reason)`,
        [s.tenantId, declaration.id,
         lines.map(l => byBarcode.get(l.barcode) ?? null),
         lines.map(l => l.barcode),
         lines.map(l => l.qty ?? null),
         lines.map(l => (l.reason ?? '').trim())]
      );
    }

    return { id: declaration.id, kind: input.kind, pieces: lines.length, state: 'submitted' };
  });
}

// ----------------------------------------------------- what the mill says --

/**
 * Gives one process house a login. The account is created deactivated for the
 * mill application by having no membership at all — it exists only as a portal
 * binding, so there is no role to accidentally widen later.
 */
export async function createPortalUser(
  ctx: { db: Db; tenantId: string; userId: string },
  input: { email: string; fullName: string; partyId: string; password: string }
) {
  const party = await one<{ id: string; name: string }>(
    ctx.db, 'select id, name from ledger_account where id = $1 and is_active', [input.partyId]
  );
  if (!party) throw new Error('no such party');

  const clash = await one<{ id: string }>(
    ctx.db, 'select id from app_user where email = $1', [input.email.toLowerCase()]
  );
  if (clash) {
    const staff = await one<{ n: number }>(
      ctx.db, 'select count(*)::int as n from membership where user_id = $1', [clash.id]
    );
    // Refusing to reuse a staff address is the point: one login must never be
    // both an employee and an outside party.
    if ((staff?.n ?? 0) > 0) throw new Error('that address already belongs to a mill user');
  }

  const hash = await hashPassword(input.password);
  const user = clash ?? await one<{ id: string }>(
    ctx.db,
    `insert into app_user (email, full_name, password_hash)
     values ($1,$2,$3) returning id`,
    [input.email.toLowerCase(), input.fullName, hash]
  );
  if (!user) throw new Error('could not create the login');

  await ctx.db.query(
    `insert into party_portal_user (tenant_id, user_id, party_id, created_by)
     values ($1,$2,$3,$4)
     on conflict (tenant_id, user_id)
       do update set party_id = excluded.party_id, is_active = true`,
    [ctx.tenantId, user.id, party.id, ctx.userId]
  );

  return { userId: user.id, email: input.email.toLowerCase(), party: party.name };
}

/**
 * The mill's answer. Recorded as an event rather than an edit, so a process
 * house cannot later be told it never said what it said, and the mill cannot
 * later be told it never answered.
 */
export async function answerDeclaration(
  ctx: { db: Db; tenantId: string; userId: string },
  declarationId: string,
  state: 'accepted' | 'rejected',
  note: string
) {
  const row = await one<{ kind: string; party: string; current: string | null }>(
    ctx.db,
    `select d.kind::text as kind, l.name as party,
            (select e.state::text from party_declaration_event e
              where e.declaration_id = d.id order by e.id desc limit 1) as current
       from party_declaration d
       join ledger_account l on l.id = d.party_id
      where d.id = $1`,
    [declarationId]
  );
  if (!row) throw new Error('declaration not found');
  if (row.current) throw new Error(`that declaration was already ${row.current}`);

  await ctx.db.query(
    `insert into party_declaration_event (tenant_id, declaration_id, state, note, actor_id)
     values ($1,$2,$3::declaration_state,$4,$5)`,
    [ctx.tenantId, declarationId, state, note.trim(), ctx.userId]
  );
  return { declarationId, kind: row.kind, party: row.party, state };
}
