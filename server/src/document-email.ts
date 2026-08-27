import { many, one, withTenant, type Db } from './db.ts';
import { isConfigured, sendMail, SmtpNotConfigured } from './smtp.ts';
import type { Ctx } from './domain.ts';

/**
 * Emailing a document from the document.
 *
 * Two rules shape this. Delivery never runs inside the transaction that made
 * the document — a slow mail server must not be able to roll back an invoice.
 * And nothing is rendered until the moment it is sent, because a document can
 * be revised between queueing and delivery and the party should receive what
 * the books say now, not what they said at four o'clock.
 */

export type DocType =
  | 'sales_invoice' | 'delivery_challan' | 'party_statement'
  | 'ledger_confirmation' | 'purchase_order' | 'packing_list';

interface Recipient { email: string | null; name: string }

/** Where each document's party lives, and what the mail should be called. */
const DOCUMENTS: Record<DocType, {
  label: string;
  /** Returns the party to send to, and the document's own reference. */
  lookup: (db: Db, id: string) => Promise<{ ref: string; party: Recipient } | null>;
}> = {
  sales_invoice: {
    label: 'Tax Invoice',
    lookup: async (db, id) => one(db,
      `select i.invoice_no as ref, l.email, l.name
         from sales_invoice i join ledger_account l on l.id = i.party_id
        where i.id = $1`, [id]).then(shape)
  },
  delivery_challan: {
    label: 'Delivery Challan',
    lookup: async (db, id) => one(db,
      `select di.challan_no as ref, l.email, l.name
         from dyeing_issue di join ledger_account l on l.id = di.process_house_id
        where di.id = $1`, [id]).then(shape)
  },
  packing_list: {
    label: 'Packing List',
    lookup: async (db, id) => one(db,
      `select d.challan_no as ref, l.email, l.name
         from dispatch d join ledger_account l on l.id = d.party_id
        where d.id = $1`, [id]).then(shape)
  },
  purchase_order: {
    label: 'Purchase Order',
    lookup: async (db, id) => one(db,
      `select o.order_no as ref, l.email, l.name
         from grey_purchase_order o join ledger_account l on l.id = o.party_id
        where o.id = $1`, [id]).then(shape)
  },
  party_statement: {
    label: 'Statement of Account',
    lookup: async (db, id) => one(db,
      'select code as ref, email, name from ledger_account where id = $1', [id]).then(shape)
  },
  ledger_confirmation: {
    label: 'Ledger Confirmation',
    lookup: async (db, id) => one(db,
      'select code as ref, email, name from ledger_account where id = $1', [id]).then(shape)
  }
};

const shape = (row: any) =>
  row ? { ref: String(row.ref), party: { email: row.email ?? null, name: row.name } } : null;

export const DOC_TYPES = Object.keys(DOCUMENTS) as DocType[];

export interface QueueInput {
  docType: DocType;
  docId: string;
  /** Overrides the party's address on file, for a one-off. */
  toEmail?: string | null;
  ccEmail?: string | null;
  note?: string;
}

/**
 * Puts one document in the outbox. Refuses rather than guessing: a document
 * with no address on file and none supplied is a mistake to correct, not a
 * mail to invent a recipient for.
 */
export async function queueDocumentEmail(ctx: Ctx, input: QueueInput) {
  const spec = DOCUMENTS[input.docType];
  if (!spec) throw new Error(`cannot email a ${input.docType}`);

  const found = await spec.lookup(ctx.db, input.docId);
  if (!found) throw new Error(`no ${input.docType.replace('_', ' ')} with that id`);

  const to = (input.toEmail ?? found.party.email ?? '').trim();
  if (!to) {
    throw new Error(
      `${found.party.name} has no email address on file — add one on the ledger, ` +
      'or type an address for this one document'
    );
  }

  const mill = await one<{ legal_name: string }>(
    ctx.db, 'select legal_name from tenant where id = $1', [ctx.tenantId]);
  const millName = mill?.legal_name ?? 'the mill';
  const subject = `${spec.label} ${found.ref} from ${millName}`;
  const body = [
    `Dear ${found.party.name},`,
    '',
    `Please find attached ${spec.label.toLowerCase()} ${found.ref}.`,
    ...(input.note?.trim() ? ['', input.note.trim()] : []),
    '',
    'Please write back if anything does not agree with your records.',
    '',
    `For ${millName}`
  ].join('\n');

  const row = await one<{ id: string; state: string }>(
    ctx.db,
    `insert into document_email (tenant_id, doc_type, doc_id, to_email, to_name,
                                 cc_email, subject, body, attachment_name, queued_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     returning id, state::text as state`,
    [ctx.tenantId, input.docType, input.docId, to, found.party.name,
     input.ccEmail?.trim() || null, subject, body,
     `${input.docType}-${found.ref}.pdf`.replace(/[^A-Za-z0-9._-]+/g, '-'), ctx.userId]
  );
  if (!row) throw new Error('outbox insert returned nothing');

  return {
    id: row.id, state: row.state, to, subject,
    /** False means it will sit in the outbox until SMTP is configured. */
    deliverable: isConfigured()
  };
}

// ------------------------------------------------------------------ worker --

/** Doubling, capped, so a mail server that is down is retried but not hammered. */
const BACKOFF_SECONDS = [60, 300, 900, 3600, 10_800, 21_600];
const backoffFor = (attempt: number) =>
  BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length) - 1] ?? 21_600;

export interface Renderer {
  (db: Db, tenantId: string, docType: DocType, docId: string): Promise<Buffer | null>;
}

interface Pending {
  id: string; tenant_id: string; doc_type: DocType; doc_id: string;
  to_email: string; to_name: string; cc_email: string | null;
  subject: string; body: string; attachment_name: string; attempts: number;
}

/**
 * Claims due mail and sends it, one at a time.
 *
 * `for update skip locked` so two workers never send the same document twice,
 * and each row is settled in its own transaction: a failure on the fourth mail
 * must not roll back the three that already left.
 */
export async function deliverPending(
  pool: { query: Db['query'] }, render: Renderer, limit = 20
): Promise<{ sent: number; failed: number; blocked: string | null }> {
  if (!isConfigured()) {
    // Nothing is claimed, nothing is retried, and the reason is reported.
    const missing = new SmtpNotConfigured([]).message;
    return { sent: 0, failed: 0, blocked: missing };
  }

  const due = await many<Pending>(
    pool as Db,
    `select id, tenant_id, doc_type, doc_id, to_email, to_name, cc_email,
            subject, body, attachment_name, attempts
       from document_email
      where state in ('pending', 'failed')
        and next_attempt_at <= now()
        and attempts < 20
      order by next_attempt_at
      limit $1`,
    [limit]
  );

  let sent = 0;
  let failed = 0;
  for (const mail of due) {
    const claimed = await one<{ id: string }>(
      pool as Db,
      `update document_email set state = 'sending'
        where id = $1 and state in ('pending', 'failed') returning id`,
      [mail.id]
    );
    if (!claimed) continue;

    try {
      const pdf = await withTenant(mail.tenant_id, null, db =>
        render(db, mail.tenant_id, mail.doc_type, mail.doc_id));
      if (!pdf) throw new Error('the document could not be rendered');

      await sendMail({
        to: mail.to_email, toName: mail.to_name, cc: mail.cc_email,
        subject: mail.subject, body: mail.body,
        attachment: { filename: mail.attachment_name, content: pdf, mime: 'application/pdf' }
      });

      await pool.query(
        `update document_email set state = 'sent', sent_at = now(), last_error = null,
                                   attempts = attempts + 1 where id = $1`,
        [mail.id]);
      sent += 1;
    } catch (e) {
      const attempt = mail.attempts + 1;
      await pool.query(
        `update document_email
            set state = 'failed', attempts = $2, last_error = $3,
                next_attempt_at = now() + make_interval(secs => $4)
          where id = $1`,
        [mail.id, attempt, (e as Error).message.slice(0, 500), backoffFor(attempt)]);
      failed += 1;
    }
  }
  return { sent, failed, blocked: null };
}
