import { one, withTenant, type Db } from './db.ts';
import { FetchTransport, IrpClient, type IrpCredentials, type IrpResult } from './irp.ts';
import {
  enqueue, recordAttempt, claimDue, runOne, type AttemptOutcome, type Ctx
} from './provider-queue.ts';

/**
 * Submits a stored e-invoice payload to the IRP and records the outcome.
 * Credentials come from the environment; without them the endpoint reports
 * that it is not configured rather than pretending to have filed anything.
 */
export type IrpMode = 'disabled' | 'sandbox' | 'production';

export function irpRuntimeStatus() {
  const rawMode = process.env.IRP_MODE ?? 'disabled';
  const mode: IrpMode = rawMode === 'sandbox' || rawMode === 'production' ? rawMode : 'disabled';
  const { IRP_BASE_URL, IRP_CLIENT_ID, IRP_CLIENT_SECRET, IRP_USERNAME, IRP_PASSWORD } = process.env;
  const complete = Boolean(IRP_BASE_URL && IRP_CLIENT_ID && IRP_CLIENT_SECRET && IRP_USERNAME && IRP_PASSWORD);
  const secureUrl = Boolean(IRP_BASE_URL && /^https:\/\//i.test(IRP_BASE_URL));
  const configured = mode !== 'disabled' && complete && secureUrl;
  return {
    mode,
    configured,
    baseUrl: IRP_BASE_URL ? new URL(IRP_BASE_URL).origin : null,
    message: mode === 'disabled'
      ? 'provider calls are disabled'
      : !complete
        ? `${mode} mode is selected but credentials are incomplete`
        : !secureUrl
          ? 'IRP_BASE_URL must use HTTPS'
          : `${mode} provider is configured; no acceptance is claimed until the recorded round trip succeeds`
  };
}

function credentials(gstin: string): IrpCredentials | null {
  const status = irpRuntimeStatus();
  const { IRP_BASE_URL, IRP_CLIENT_ID, IRP_CLIENT_SECRET, IRP_USERNAME, IRP_PASSWORD } = process.env;
  if (!status.configured) return null;
  return {
    baseUrl: IRP_BASE_URL!,
    clientId: IRP_CLIENT_ID!,
    clientSecret: IRP_CLIENT_SECRET!,
    username: IRP_USERNAME!,
    password: IRP_PASSWORD!,
    gstin
  };
}

interface InvoiceWork {
  payload: Record<string, unknown> | null; filing_status: string;
  irn: string | null; invoice_no: string; seller_gstin: string;
}

async function invoiceWork(db: Db, invoiceId: string) {
  return one<InvoiceWork>(
    db,
    `select g.payload, g.filing_status, g.irn, i.invoice_no, t.gstin as seller_gstin
       from gst_document g
       join sales_invoice i on i.id = g.invoice_id
       join tenant t on t.id = i.tenant_id
      where g.invoice_id = $1`,
    [invoiceId]
  );
}

const outcomeFor = (result: IrpResult): AttemptOutcome => result.ok
  ? { ok: true, code: 'ACCEPTED', message: `IRN ${result.irn}` }
  : { ok: false, code: result.code, message: result.message, retryable: result.retryable };

/** Exactly one network attempt. The durable queue, not the HTTP client, owns retries. */
async function generateOnce(ctx: Ctx, invoiceId: string) {
  const row = await invoiceWork(ctx.db, invoiceId);
  if (!row?.payload) {
    return { outcome: { ok: false, code: 'NO_PAYLOAD', message: 'no stored e-invoice payload', retryable: false } as AttemptOutcome };
  }
  const creds = credentials(row.seller_gstin);
  if (!creds) {
    return { outcome: { ok: false, code: 'NOT_CONFIGURED', message: irpRuntimeStatus().message, retryable: false } as AttemptOutcome };
  }

  const result = await new IrpClient(creds, new FetchTransport(creds.baseUrl), 1).generateIrn(row.payload);
  if (result.ok) {
    await ctx.db.query(
      `update gst_document
          set irn = $1, ack_no = $2, ack_date = nullif($3,'')::timestamptz,
              signed_qr = $4, eway_bill_no = $5,
              eway_valid_until = nullif($6,'')::timestamptz,
              filing_status = 'accepted', last_error = null
        where invoice_id = $7`,
      [result.irn, result.ackNo, result.ackDate, result.signedQr ?? null,
       result.ewayBillNo ?? null, result.ewayValidUntil ?? '', invoiceId]
    );
  } else {
    await ctx.db.query(
      `update gst_document set filing_status = $1, last_error = $2 where invoice_id = $3`,
      [result.retryable ? 'pending' : 'rejected', `${result.code}: ${result.message}`, invoiceId]
    );
  }
  return { outcome: outcomeFor(result), result, invoiceNo: row.invoice_no };
}

export async function submitInvoiceToIrp(tenantId: string, userId: string, invoiceId: string) {
  return withTenant(tenantId, userId, async db => {
    const row = await invoiceWork(db, invoiceId);
    if (!row) return { ok: false as const, error: 'no e-invoice payload for that invoice' };
    if (row.irn) {
      return { ok: true as const, irn: row.irn, alreadyRegistered: true, invoiceNo: row.invoice_no };
    }
    if (row.filing_status === 'invalid') {
      return { ok: false as const, error: 'payload failed local validation; fix the masters first' };
    }
    if (!row.payload) return { ok: false as const, error: 'payload is empty' };

    if (!credentials(row.seller_gstin)) {
      return {
        ok: false as const,
        error: irpRuntimeStatus().message,
        notConfigured: true
      };
    }

    // Queued rather than fired: the attempt is recorded, bounded and
    // idempotent, so an ambiguous timeout cannot register the same invoice
    // twice and a failure leaves a history rather than one overwritten string.
    const submission = await enqueue(
      { db, tenantId, userId },
      { channel: 'einvoice', docType: 'sales_invoice', docId: invoiceId }
    );

    const startedAt = new Date();
    const performed = await generateOnce({ db, tenantId, userId }, invoiceId);
    await recordAttempt(
      { db, tenantId, userId }, submission.id, submission.attempts + 1,
      performed.outcome,
      startedAt
    );

    const result = performed.result;
    if (!result) return { ok: false as const, error: performed.outcome.message ?? 'submission failed' };
    if (result.ok) {
      return { ok: true as const, irn: result.irn, ackNo: result.ackNo, invoiceNo: row.invoice_no };
    }
    return {
      ok: false as const,
      error: result.message,
      code: result.code,
      retryable: result.retryable
    };
  });
}

/** Runs due work for the signed-in tenant; safe to call repeatedly or concurrently. */
export async function runDueProviderSubmissions(
  tenantId: string, userId: string, limit = 10
) {
  return withTenant(tenantId, userId, async db => {
    const ctx = { db, tenantId, userId };
    const claimed = await claimDue(ctx, Math.min(Math.max(limit, 1), 50));
    const results: { id: string; state: string }[] = [];
    for (const submission of claimed) {
      const result = await runOne(ctx, submission, async () => {
        if (submission.channel === 'einvoice' && submission.action === 'generate'
            && submission.doc_type === 'sales_invoice') {
          return (await generateOnce(ctx, submission.doc_id)).outcome;
        }
        return {
          ok: false, code: 'NO_ADAPTER',
          message: `no provider adapter for ${submission.channel}/${submission.action}`,
          retryable: false
        };
      });
      results.push({ id: submission.id, state: result.state });
    }
    return { claimed: claimed.length, results };
  });
}

/** Queues and performs a real IRN cancellation only when a provider is configured. */
export async function cancelInvoiceIrn(
  tenantId: string, userId: string, invoiceId: string, reasonCode: string, remarks: string
) {
  return withTenant(tenantId, userId, async db => {
    const row = await invoiceWork(db, invoiceId);
    if (!row?.irn) return { ok: false as const, error: 'that invoice has no IRN to cancel' };
    const creds = credentials(row.seller_gstin);
    if (!creds) return { ok: false as const, error: irpRuntimeStatus().message, notConfigured: true };

    const submission = await enqueue(
      { db, tenantId, userId },
      { channel: 'einvoice', action: 'cancel', docType: 'sales_invoice', docId: invoiceId }
    );
    const startedAt = new Date();
    const result = await new IrpClient(creds, new FetchTransport(creds.baseUrl), 1)
      .cancelIrn(row.irn, reasonCode, remarks);
    await recordAttempt(
      { db, tenantId, userId }, submission.id, submission.attempts + 1,
      result.ok
        ? { ok: true, code: 'CANCELLED', message: `IRN ${row.irn} cancelled` }
        : outcomeFor(result),
      startedAt
    );

    if (!result.ok) return { ok: false as const, error: result.message, code: result.code };
    await db.query(
      `update gst_document set filing_status='cancelled', cancelled_at=now(), cancel_reason=$2,
                               last_error=null where invoice_id=$1`,
      [invoiceId, remarks]
    );
    return { ok: true as const, irn: row.irn, cancelled: true, invoiceNo: row.invoice_no };
  });
}
