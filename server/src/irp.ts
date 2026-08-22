/**
 * IRP submission. The transport is injected, so the whole flow — auth, submit,
 * retry, persist, cancel — is exercised in tests without live credentials. The
 * real transport is a thin fetch; nothing else changes when it is plugged in.
 *
 * NOT YET VERIFIED against a live IRP. Endpoint paths and response envelope
 * follow the published GSP documentation cited in docs/einvoice-schema.md, but
 * no sandbox round-trip has happened. Treat the field names below as a
 * hypothesis until one has.
 */

export interface IrpCredentials {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  gstin: string;
}

export interface IrpSuccess {
  ok: true;
  irn: string;
  ackNo: string;
  ackDate: string;
  signedQr?: string;
  ewayBillNo?: string;
  ewayValidUntil?: string;
}

export interface IrpFailure {
  ok: false;
  /** IRP error codes are numeric strings, e.g. "2150" for a duplicate IRN. */
  code: string;
  message: string;
  retryable: boolean;
}

export type IrpResult = IrpSuccess | IrpFailure;

/** Anything that can carry a request to the IRP; real or fake. */
export interface IrpTransport {
  post(path: string, body: unknown, headers: Record<string, string>): Promise<{
    status: number;
    body: any;
  }>;
}

/**
 * A duplicate IRN is not a failure worth retrying — the invoice is already
 * registered and the IRP hands the existing IRN back. Everything transient
 * (timeouts, gateway errors, rate limits) is.
 */
const NON_RETRYABLE = new Set(['2150', '2172', '2189', '3028', '3029']);

export class IrpClient {
  readonly #creds: IrpCredentials;
  readonly #transport: IrpTransport;
  readonly #maxAttempts: number;

  constructor(creds: IrpCredentials, transport: IrpTransport, maxAttempts = 3) {
    this.#creds = creds;
    this.#transport = transport;
    this.#maxAttempts = maxAttempts;
  }

  private authHeaders() {
    return {
      'content-type': 'application/json',
      client_id: this.#creds.clientId,
      client_secret: this.#creds.clientSecret,
      user_name: this.#creds.username,
      password: this.#creds.password,
      gstin: this.#creds.gstin
    };
  }

  async generateIrn(payload: Record<string, unknown>): Promise<IrpResult> {
    return this.withRetry(() => this.#transport.post('/eicore/v1.03/Invoice', payload, this.authHeaders()));
  }

  async cancelIrn(irn: string, reason: string, remarks: string): Promise<IrpResult> {
    return this.withRetry(() =>
      this.#transport.post('/eicore/v1.03/Invoice/Cancel',
        { Irn: irn, CnlRsn: reason, CnlRem: remarks }, this.authHeaders()));
  }

  private async withRetry(send: () => Promise<{ status: number; body: any }>): Promise<IrpResult> {
    let last: IrpFailure = { ok: false, code: 'NO_ATTEMPT', message: 'not attempted', retryable: false };

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      let res: { status: number; body: any };
      try {
        res = await send();
      } catch (err) {
        last = {
          ok: false, code: 'TRANSPORT',
          message: err instanceof Error ? err.message : String(err),
          retryable: true
        };
        continue;
      }

      const parsed = interpret(res);
      if (parsed.ok || !parsed.retryable) return parsed;
      last = parsed;
    }
    return last;
  }
}

export function interpret(res: { status: number; body: any }): IrpResult {
  const b = res.body ?? {};

  // The IRP signals success with Status "1" and the details under Data.
  if (res.status === 200 && (b.Status === 1 || b.Status === '1')) {
    const data = typeof b.Data === 'string' ? safeParse(b.Data) : b.Data;
    if (!data?.Irn) {
      return { ok: false, code: 'NO_IRN', message: 'accepted but no IRN returned', retryable: false };
    }
    return {
      ok: true,
      irn: data.Irn,
      ackNo: String(data.AckNo ?? ''),
      ackDate: String(data.AckDt ?? ''),
      signedQr: data.SignedQRCode,
      ewayBillNo: data.EwbNo ? String(data.EwbNo) : undefined,
      ewayValidUntil: data.EwbValidTill
    };
  }

  if (res.status >= 500 || res.status === 429) {
    return {
      ok: false, code: String(res.status),
      message: b.message ?? 'IRP is unavailable', retryable: true
    };
  }

  const errors: { ErrorCode?: string; ErrorMessage?: string }[] =
    Array.isArray(b.ErrorDetails) ? b.ErrorDetails
    : b.ErrorDetails ? [b.ErrorDetails] : [];
  const first = errors[0];
  const code = String(first?.ErrorCode ?? b.ErrorCode ?? res.status);

  return {
    ok: false,
    code,
    message: errors.length
      ? errors.map(e => `${e.ErrorCode}: ${e.ErrorMessage}`).join('; ')
      : (b.ErrorMessage ?? b.message ?? `IRP rejected the document (HTTP ${res.status})`),
    retryable: !NON_RETRYABLE.has(code) && res.status >= 500
  };
}

function safeParse(s: string) {
  try { return JSON.parse(s); } catch { return null; }
}

/** The real transport. Everything above is provider-agnostic. */
export class FetchTransport implements IrpTransport {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = 20_000) {
    this.#baseUrl = baseUrl;
    this.#timeoutMs = timeoutMs;
  }

  async post(path: string, body: unknown, headers: Record<string, string>) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.#timeoutMs);
    try {
      const res = await fetch(`${this.#baseUrl}${path}`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    } finally {
      clearTimeout(timer);
    }
  }
}
