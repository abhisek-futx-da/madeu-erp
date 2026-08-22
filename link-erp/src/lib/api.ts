const BASE = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:4000';

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly issues?: unknown) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...init.headers
    }
  });

  const text = await res.text();
  const body = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? res.statusText, body?.issues);
  }
  return body as T;
}

/**
 * Downloads a CSV. The bearer token lives in a header, so a plain <a href>
 * would arrive unauthenticated — the file has to be fetched and handed to the
 * browser as a blob.
 */
async function download(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`${BASE}/api${path}`, {
    credentials: 'include'
  });
  if (!res.ok) {
    throw new ApiError(res.status, `export failed (${res.status})`);
  }
  const named = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = named?.[1] ?? `${fallbackName}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  download
};

/** Every list endpoint answers with this envelope. */
export interface Page<T> { rows: T[]; total: number; limit: number; offset: number }

// ------------------------------------------------------------------ shapes --

export interface TenantInfo { legalName: string; gstin: string; fyLabel: string }
export interface UserInfo { email: string; fullName: string }
export interface Session {
  userId: string; tenantId: string; role: string;
  tenant: TenantInfo | null;
  user: UserInfo | null;
}

export interface LedgerRow {
  id: string; code: string; name: string; alias: string;
  control_account_id: string; gstin: string | null; pan: string | null;
  gst_reg_type: string; credit_days: number; is_active: boolean;
}

export interface QualityRow {
  id: string; code: string; name: string; construction: string;
  selvedge_line: string; width_cms: number | null; bill_by: string;
  hsn_code: string; division: string; is_active: boolean;
}

export interface ControlAccountRow {
  id: string; code: string; name: string; sub_control: string; nature: string;
}

export interface GradeRow { code: string; name: string; sort_order: number }
export interface HsnRow { code: string; description: string; gst_rate: number; is_service: boolean }
export interface DesignRow { id: string; quality_id: string; code: string; name: string }

export interface PieceRow {
  id: string; barcode: string; status: string; lot_no: string; grade_code: string;
  uom: string; rack_code: string | null; grey_qty: number; finish_qty: number | null; current_qty: number;
  /** Grey plus jobwork plus everything else the piece has absorbed. */
  cost: number;
  quality: string; design: string | null; held_by: string | null;
}

export interface MovementRow {
  barcode: string; lot_no: string; quality: string; design: string | null;
  event: string; from_status: string | null; to_status: string;
  qty_before: number; qty_after: number; counterparty: string | null;
  doc_type: string; occurred_at: string;
}

export const auth = {
  login: (email: string, password: string) =>
    request<{ token: string; tenant: string; role: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    }),
  me: () => api.get<Session>('/me'),
  logout: () => api.post<{ signedOut: boolean }>('/auth/logout', {})
};

export const STATUS_LABEL: Record<string, string> = {
  grey_in_stock: 'Grey In Stock',
  issued_to_dyeing: 'Issued To Dyeing',
  received_finish: 'Received Finish',
  cut_packed: 'Cut / Packed',
  dispatched: 'Dispatched',
  returned_to_weaver: 'Returned To Weaver',
  written_off: 'Written Off',
  consumed: 'Cut Up / Joined'
};
