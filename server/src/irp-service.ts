import { one, withTenant } from './db.ts';
import { FetchTransport, IrpClient, type IrpCredentials } from './irp.ts';
import { enqueue, recordAttempt } from './provider-queue.ts';

/**
 * Submits a stored e-invoice payload to the IRP and records the outcome.
 * Credentials come from the environment; without them the endpoint reports
 * that it is not configured rather than pretending to have filed anything.
 */
function credentials(gstin: string): IrpCredentials | null {
  const { IRP_BASE_URL, IRP_CLIENT_ID, IRP_CLIENT_SECRET, IRP_USERNAME, IRP_PASSWORD } = process.env;
  if (!IRP_BASE_URL || !IRP_CLIENT_ID || !IRP_CLIENT_SECRET || !IRP_USERNAME || !IRP_PASSWORD) {
    return null;
  }
  return {
    baseUrl: IRP_BASE_URL,
    clientId: IRP_CLIENT_ID,
    clientSecret: IRP_CLIENT_SECRET,
    username: IRP_USERNAME,
    password: IRP_PASSWORD,
    gstin
  };
}

export async function submitInvoiceToIrp(tenantId: string, userId: string, invoiceId: string) {
  return withTenant(tenantId, userId, async db => {
    const row = await one<{
      payload: Record<string, unknown> | null; filing_status: string;
      irn: string | null; invoice_no: string; seller_gstin: string;
    }>(
      db,
      `select g.payload, g.filing_status, g.irn, i.invoice_no, t.gstin as seller_gstin
         from gst_document g
         join sales_invoice i on i.id = g.invoice_id
         join tenant t on t.id = i.tenant_id
        where g.invoice_id = $1`,
      [invoiceId]
    );
    if (!row) return { ok: false as const, error: 'no e-invoice payload for that invoice' };
    if (row.irn) {
      return { ok: true as const, irn: row.irn, alreadyRegistered: true, invoiceNo: row.invoice_no };
    }
    if (row.filing_status === 'invalid') {
      return { ok: false as const, error: 'payload failed local validation; fix the masters first' };
    }
    if (!row.payload) return { ok: false as const, error: 'payload is empty' };

    const creds = credentials(row.seller_gstin);
    if (!creds) {
      return {
        ok: false as const,
        error: 'IRP credentials are not configured (set IRP_BASE_URL, IRP_CLIENT_ID, ' +
               'IRP_CLIENT_SECRET, IRP_USERNAME, IRP_PASSWORD)',
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

    const client = new IrpClient(creds, new FetchTransport(creds.baseUrl));
    const startedAt = new Date();
    const result = await client.generateIrn(row.payload);
    await recordAttempt(
      { db, tenantId, userId }, submission.id, submission.attempts + 1,
      result.ok
        ? { ok: true, code: 'ACCEPTED', message: `IRN ${result.irn}` }
        : { ok: false, code: result.code, message: result.message, retryable: result.retryable },
      startedAt
    );

    if (result.ok) {
      await db.query(
        `update gst_document
            set irn = $1, ack_no = $2, ack_date = nullif($3,'')::timestamptz,
                signed_qr = $4, eway_bill_no = $5,
                eway_valid_until = nullif($6,'')::timestamptz,
                filing_status = 'accepted', last_error = null
          where invoice_id = $7`,
        [result.irn, result.ackNo, result.ackDate, result.signedQr ?? null,
         result.ewayBillNo ?? null, result.ewayValidUntil ?? '', invoiceId]
      );
      return { ok: true as const, irn: result.irn, ackNo: result.ackNo, invoiceNo: row.invoice_no };
    }

    await db.query(
      `update gst_document set filing_status = 'rejected', last_error = $1 where invoice_id = $2`,
      [`${result.code}: ${result.message}`, invoiceId]
    );
    return {
      ok: false as const,
      error: result.message,
      code: result.code,
      retryable: result.retryable
    };
  });
}
