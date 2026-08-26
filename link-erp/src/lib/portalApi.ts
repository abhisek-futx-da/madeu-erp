/**
 * The process-house client.
 *
 * Deliberately separate from `api.ts`. The mill's application authenticates
 * with a cookie; if the portal shared it, signing in at a dyeing house on the
 * same browser would silently replace the storekeeper's session, and signing
 * out of one would sign out of the other. A portal session is a bearer token in
 * `sessionStorage` instead: scoped to the tab, gone when it closes, which is
 * the right lifetime for a login used on a shared machine in somebody else's
 * office.
 */

const BASE = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:4000';
const TOKEN_KEY = 'link-erp:portal-token';

export class PortalError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const read = (): string | null => {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
};

export const portalToken = read;

export function setPortalToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* a locked-down browser simply signs in again next time */ }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = read();
  const res = await fetch(`${BASE}/api/portal${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers
    }
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // A dead session should drop the token rather than loop on refusals.
    if (res.status === 401 || res.status === 403) setPortalToken(null);
    throw new PortalError(res.status, body?.error ?? res.statusText);
  }
  return body as T;
}

export const portalApi = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),

  async signIn(email: string, password: string) {
    const res = await fetch(`${BASE}/api/portal/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw new PortalError(res.status, body?.error ?? res.statusText);
    setPortalToken(body.token);
    return body as { token: string; mill: string; party: string };
  },

  signOut() {
    request('/auth/logout', { method: 'POST' }).catch(() => {});
    setPortalToken(null);
  }
};

// ------------------------------------------------------------------ shapes --

export interface PortalChallan {
  issue_id: string; entry_no: string; challan_no: string; challan_date: string;
  lot_no: string; pieces: number; issued_qty: number; job_rate: number | null;
  acknowledged_at: string | null; expected_on: string | null; any_returned: boolean;
}

export interface PortalPiece {
  piece_id: string; barcode: string; quality: string; design: string | null;
  lot_no: string; grade_code: string; current_qty: number; uom: string;
  entry_no: string | null; challan_no: string | null; issued_qty: number | null;
}

export interface PortalDeclaration {
  declaration_id: string; kind: string; their_ref: string; vehicle_no: string | null;
  expected_on: string | null; note: string; declared_at: string;
  entry_no: string | null; challan_no: string | null;
  state: string; mill_note: string | null; answered_at: string | null; pieces: number;
}

export const DECLARATION_LABEL: Record<string, string> = {
  custody_ack: 'Goods received',
  shortage: 'Short delivery',
  rejection: 'Damaged or off-shade',
  expected_return: 'Expected return date',
  return_dispatch: 'Sent back'
};

export const STATE_LABEL: Record<string, string> = {
  submitted: 'Waiting for the mill',
  accepted: 'Accepted',
  rejected: 'Not accepted'
};
