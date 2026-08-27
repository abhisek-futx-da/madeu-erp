/** Dependency-free PDF writer for the document sent through WhatsApp. The
 * browser print view remains richer; this produces a stable, portable tax
 * invoice plus piece-wise packing/LR page without a headless-browser runtime. */

export interface InvoiceBundleLine {
  sno: number; description: string; hsn_code: string; barcode: string;
  grade_code: string; qty: number; uom: string; rate: number;
  taxable_value: number; gst_rate: number; cgst_amount: number;
  sgst_amount: number; igst_amount: number; line_total: number;
  current_weight_kg: number | null;
}

export interface InvoiceBundle {
  invoice_no: string; invoice_date: string; status: string;
  mill_name: string; mill_gstin: string; mill_address: string;
  party_name: string; party_gstin: string | null; party_address: string;
  place_of_supply: string; supply_type: string; irn: string | null;
  challan_no: string; challan_date: string; lr_no: string | null;
  lr_date: string | null; vehicle_no: string | null; transporter: string | null;
  taxable_value: number; cgst_amount: number; sgst_amount: number;
  igst_amount: number; round_off: number; invoice_total: number;
  amount_in_words: string; lines: InvoiceBundleLine[];
}

export interface PartyStatementLine {
  invoice_no: string; invoice_date: string; due_date: string;
  invoice_total: number; received_or_credited: number; outstanding: number;
  overdue_days: number;
}

export interface PartyStatementBundle {
  mill_name: string; mill_gstin: string; mill_address: string;
  party_name: string; party_gstin: string | null; party_address: string;
  as_of: string; total_outstanding: number; total_overdue: number;
  lines: PartyStatementLine[];
}

const ascii = (value: unknown, limit = 110) => String(value ?? '')
  .normalize('NFKD').replace(/[^\x20-\x7e]/g, '?').slice(0, limit);
const pdfString = (value: unknown, limit = 110) => ascii(value, limit)
  .replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
const money = (value: number) => Number(value).toFixed(2);
const cell = (value: unknown, width: number, right = false) => {
  const text = ascii(value, width);
  return right ? text.padStart(width) : text.padEnd(width);
};

type PdfPage = Array<{ text: string; x: number; y: number; size?: number; bold?: boolean }>;

function invoicePages(doc: InvoiceBundle): PdfPage[] {
  const pages: PdfPage[] = [];
  let page: PdfPage = [];
  let y = 806;
  const add = (text: string, x = 38, size = 9, gap = 13, bold = false) => {
    page.push({ text, x, y, size, bold }); y -= gap;
  };
  const push = () => { pages.push(page); page = []; y = 806; };
  const invoiceHeader = (continued = false) => {
    add(doc.mill_name, 38, 16, 20, true);
    add(`GSTIN: ${doc.mill_gstin}    ${continued ? 'TAX INVOICE (continued)' : 'TAX INVOICE'}`, 38, 10, 18, true);
    add(doc.mill_address, 38, 8, 16);
  };

  invoiceHeader();
  add(`Invoice: ${doc.invoice_no}   Date: ${doc.invoice_date}   Status: ${doc.status.toUpperCase()}`, 38, 10, 16, true);
  add(`Billed to: ${doc.party_name}   GSTIN: ${doc.party_gstin ?? 'URP'}   POS: ${doc.place_of_supply}`, 38, 9, 13);
  add(doc.party_address, 38, 8, 16);
  add(`Dispatch: ${doc.challan_no} / ${doc.challan_date}   LR: ${doc.lr_no ?? '-'} / ${doc.lr_date ?? '-'}   Vehicle: ${doc.vehicle_no ?? '-'}`, 38, 8, 16);
  add(' #  Description                   HSN       Qty UQC       Rate     Taxable GST%        Tax       Total', 38, 8, 14, true);
  for (const line of doc.lines) {
    if (y < 120) { push(); invoiceHeader(true); add(' #  Description                   HSN       Qty UQC       Rate     Taxable GST%        Tax       Total', 38, 8, 14, true); }
    const tax = Number(line.cgst_amount) + Number(line.sgst_amount) + Number(line.igst_amount);
    add(`${cell(line.sno, 3, true)}  ${cell(line.description, 28)} ${cell(line.hsn_code, 8)} ` +
      `${cell(Number(line.qty).toFixed(2), 9, true)} ${cell(line.uom, 3)} ${cell(money(line.rate), 10, true)} ` +
      `${cell(money(line.taxable_value), 11, true)} ${cell(Number(line.gst_rate).toFixed(2), 5, true)} ` +
      `${cell(money(tax), 10, true)} ${cell(money(line.line_total), 11, true)}`, 38, 7.5, 12);
  }
  y -= 6;
  add(`Taxable: Rs ${money(doc.taxable_value)}   CGST: ${money(doc.cgst_amount)}   SGST: ${money(doc.sgst_amount)}   IGST: ${money(doc.igst_amount)}`, 38, 9, 14, true);
  add(`Round off: ${money(doc.round_off)}     INVOICE TOTAL: Rs ${money(doc.invoice_total)}`, 38, 11, 17, true);
  add(doc.amount_in_words, 38, 8, 16);
  if (doc.irn) add(`IRN: ${doc.irn}`, 38, 7, 14);
  add('This computer-generated document is subject to the mill-approved terms and statutory review.', 38, 7, 13);
  push();

  add(doc.mill_name, 38, 15, 20, true);
  add('PACKING LIST / TRANSPORT REFERENCE', 38, 11, 18, true);
  add(`Invoice ${doc.invoice_no}   Dispatch ${doc.challan_no}   Buyer ${doc.party_name}`, 38, 9, 14);
  add(`LR ${doc.lr_no ?? '-'} dated ${doc.lr_date ?? '-'}   Vehicle ${doc.vehicle_no ?? '-'}   Transport ${doc.transporter ?? '-'}`, 38, 9, 18);
  add(' #  Barcode                                  Grade        Metres UQC      Weight kg', 38, 8, 14, true);
  for (const line of doc.lines) {
    if (y < 90) { push(); add('PACKING LIST (continued)', 38, 12, 20, true); }
    add(`${cell(line.sno, 3, true)}  ${cell(line.barcode, 38)} ${cell(line.grade_code, 10)} ` +
      `${cell(Number(line.qty).toFixed(2), 11, true)} ${cell(line.uom, 3)} ` +
      `${cell(line.current_weight_kg == null ? '-' : Number(line.current_weight_kg).toFixed(3), 14, true)}`, 38, 8, 12);
  }
  y -= 8;
  add(`Pieces: ${doc.lines.length}     Total metres: ${doc.lines.reduce((sum, line) => sum + Number(line.qty), 0).toFixed(2)}     ` +
      `Total kg: ${doc.lines.reduce((sum, line) => sum + Number(line.current_weight_kg ?? 0), 0).toFixed(3)}`, 38, 10, 18, true);
  add('Received by / stamp: ____________________          Authorised signatory: ____________________', 38, 8, 13);
  push();
  return pages;
}

function statementPages(doc: PartyStatementBundle): PdfPage[] {
  const pages: PdfPage[] = [];
  let page: PdfPage = [];
  let y = 806;
  const add = (text: string, x = 38, size = 9, gap = 13, bold = false) => {
    page.push({ text, x, y, size, bold }); y -= gap;
  };
  const push = () => { pages.push(page); page = []; y = 806; };
  const header = (continued = false) => {
    add(doc.mill_name, 38, 16, 20, true);
    add(`GSTIN: ${doc.mill_gstin}    OUTSTANDING STATEMENT${continued ? ' (continued)' : ''}`, 38, 10, 18, true);
    add(doc.mill_address, 38, 8, 16);
  };
  header();
  add(`Party: ${doc.party_name}   GSTIN: ${doc.party_gstin ?? 'URP'}   As of: ${doc.as_of}`, 38, 10, 15, true);
  add(doc.party_address, 38, 8, 18);
  add('Invoice                       Date        Due date         Bill       Received        Balance  Overdue', 38, 8, 14, true);
  for (const line of doc.lines) {
    if (y < 100) {
      push(); header(true);
      add('Invoice                       Date        Due date         Bill       Received        Balance  Overdue', 38, 8, 14, true);
    }
    add(`${cell(line.invoice_no, 28)} ${cell(line.invoice_date, 10)}  ${cell(line.due_date, 10)} ` +
      `${cell(money(line.invoice_total), 12, true)} ${cell(money(line.received_or_credited), 14, true)} ` +
      `${cell(money(line.outstanding), 14, true)} ${cell(`${line.overdue_days} d`, 8, true)}`, 38, 8, 12);
  }
  y -= 8;
  add(`TOTAL OUTSTANDING: Rs ${money(doc.total_outstanding)}     OVERDUE: Rs ${money(doc.total_overdue)}`, 38, 11, 18, true);
  add('Please reconcile this statement with your books and contact our accounts team for any difference.', 38, 8, 14);
  add('This is a system-generated statement; payment terms and statutory documents remain authoritative.', 38, 7, 13);
  push();
  return pages;
}

function renderPages(pages: PdfPage[], box = '0 0 595 842'): Buffer {
  const objects: string[] = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'];
  const pageIds: number[] = [];
  for (const page of pages) {
    const stream = page.map(item =>
      `BT /${item.bold ? 'F2' : 'F1'} ${item.size ?? 9} Tf ${item.x} ${item.y} Td (${pdfString(item.text)}) Tj ET`
    ).join('\n');
    const contentId = objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    const pageId = objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [${box}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let output = '%PDF-1.4\n%LinkERP\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

export function renderInvoiceBundlePdf(doc: InvoiceBundle): Buffer {
  return renderPages(invoicePages(doc));
}

export function renderPartyStatementPdf(doc: PartyStatementBundle): Buffer {
  return renderPages(statementPages(doc));
}

// ------------------------------------------------------------ report PDF --

export interface ReportColumn { key: string; label: string; right?: boolean }

export interface ReportDoc {
  millName: string;
  millGstin: string;
  title: string;
  /** "01-04-2026 to 30-06-2026", or "as on 27-08-2026" for a position report. */
  period: string;
  filter: string | null;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  totals: Record<string, number>;
  /** Rows behind the totals, which exceeds `rows.length` on a truncated export. */
  totalRows: number;
  /** The column the rows break on, and the subtotal for each break. */
  groupBy?: string;
  groups?: { label: string; rows: number; totals: Record<string, number> }[];
}

/** A4 landscape. A report table is wide, and portrait clips it. */
const LANDSCAPE = '0 0 842 595';
const LEFT = 28;
const RIGHT_EDGE = 814;

/**
 * Columns are widened to fit their own content, then scaled down together if
 * the row overruns the page. Truncating every column equally would cut the
 * narrow ones that had room to spare.
 */
function columnWidths(doc: ReportDoc): number[] {
  // reduce, not Math.max(...cells): an export runs to twenty thousand rows.
  // The footer is measured too — a total is wider than any row that feeds it,
  // and sizing on the rows alone printed a truncated, wrong-looking figure.
  const width = doc.columns.map((c, i) => doc.rows.reduce(
    (widest, r) => Math.max(widest, String(r[c.key] ?? '').length),
    Math.max(c.label.length, 4,
      i === 0 ? `TOTAL (${doc.totalRows} rows)`.length
              : c.key in doc.totals ? money(doc.totals[c.key]!).length : 0)
  ));
  const budget = Math.floor((RIGHT_EDGE - LEFT) / 4.1);
  let used = width.reduce((n, w) => n + w + 1, 0);
  // Shave the widest column one character at a time until the row fits.
  while (used > budget) {
    const widest = width.indexOf(Math.max(...width));
    if (width[widest]! <= 6) break;
    width[widest] = width[widest]! - 1;
    used--;
  }
  return width;
}

function reportPages(doc: ReportDoc): PdfPage[] {
  const widths = columnWidths(doc);
  const pages: PdfPage[] = [];
  let page: PdfPage = [];
  let y = 560;
  const add = (text: string, size = 8, gap = 11, bold = false) => {
    page.push({ text, x: LEFT, y, size, bold }); y -= gap;
  };
  const row = (values: unknown[]) =>
    doc.columns.map((c, i) => cell(values[i], widths[i]!, c.right)).join(' ');
  const heading = () => {
    add(`${doc.millName}    GSTIN: ${doc.millGstin}`, 12, 15, true);
    add(`${doc.title}   —   ${doc.period}`, 10, 13, true);
    add(doc.filter ? `Filter: ${doc.filter}` : `Printed ${new Date().toISOString().slice(0, 10)}`, 7, 12);
    add(row(doc.columns.map(c => c.label)), 7, 11, true);
  };
  const push = () => { pages.push(page); page = []; y = 560; };

  const subtotal = new Map(
    (doc.groups ?? []).map(g => [g.label, g] as const));

  heading();
  let group: string | null = null;
  /** "TOTAL OF Bombay Crimpers Pvt. Ltd." — the line the reader is looking for. */
  const closeGroup = () => {
    if (group === null) return;
    const g = subtotal.get(group);
    if (!g) return;
    add(row(doc.columns.map((c, i) =>
      i === 0 ? `TOTAL OF ${group}`
              : (c.key in g.totals ? money(g.totals[c.key]!) : ''))), 7, 13, true);
  };

  for (const r of doc.rows) {
    if (doc.groupBy) {
      const label = String(r[doc.groupBy] ?? '(none)');
      if (label !== group) {
        if (y < 60) { push(); heading(); }
        closeGroup();
        group = label;
      }
    }
    if (y < 46) { push(); heading(); }
    add(row(doc.columns.map(c => {
      const v = r[c.key];
      return typeof v === 'number' ? v.toFixed(2) : v;
    })), 7, 10);
  }
  if (y < 60) { push(); heading(); }
  closeGroup();

  if (y < 62) { push(); heading(); }
  y -= 4;
  if (Object.keys(doc.totals).length > 0) {
    add(row(doc.columns.map((c, i) =>
      i === 0 ? `TOTAL (${doc.totalRows} rows)`
              : (c.key in doc.totals ? money(doc.totals[c.key]!) : ''))), 7.5, 12, true);
  }
  if (doc.rows.length !== doc.totalRows) {
    add(`${doc.rows.length} of ${doc.totalRows} rows printed — ` +
        'narrow the filter to print the rest', 7, 11, true);
  }
  add('System-generated from Link ERP. Figures are from posted documents only.', 6.5, 10);
  push();
  return pages;
}

export function renderReportPdf(doc: ReportDoc): Buffer {
  return renderPages(reportPages(doc), LANDSCAPE);
}

// ----------------------------------------------------- ledger confirmation --

export interface ConfirmationLine {
  voucher_date: string; voucher_type: string; voucher_no: string;
  narration: string; debit: number; credit: number; running_balance: number;
}

export interface ConfirmationDoc {
  millName: string; millGstin: string; millAddress: string;
  partyName: string; partyCode: string; partyGstin: string | null;
  from: string; to: string;
  opening: number; closing: number;
  totals: { debit: number; credit: number };
  lines: ConfirmationLine[];
}

/** Dr and Cr, the way an Indian ledger is read and confirmed. */
const sided = (amount: number) =>
  `${money(Math.abs(amount))} ${amount < 0 ? 'Cr' : 'Dr'}`;

/**
 * The letter a mill sends a party to agree a balance: the account as our
 * books have it, and a block for them to sign it back. This is what an
 * auditor asks for at year end, and what settles an argument in March.
 */
function confirmationPages(doc: ConfirmationDoc): PdfPage[] {
  const pages: PdfPage[] = [];
  let page: PdfPage = [];
  let y = 800;
  const add = (text: string, x = 40, size = 9, gap = 13, bold = false) => {
    page.push({ text, x, y, size, bold }); y -= gap;
  };
  const push = () => { pages.push(page); page = []; y = 800; };
  const COLUMNS = ' Date        Particulars                        Voucher            Debit           Credit          Balance';

  const heading = (continued = false) => {
    add(doc.millName, 40, 15, 19, true);
    add(`GSTIN: ${doc.millGstin}`, 40, 8, 12);
    add(doc.millAddress, 40, 8, 16);
    add(`LEDGER CONFIRMATION OF ACCOUNT${continued ? ' (continued)' : ''}`, 40, 11, 17, true);
    add(`${doc.partyCode} — ${doc.partyName}    GSTIN: ${doc.partyGstin ?? 'URP'}`, 40, 9, 13, true);
    add(`For the period ${doc.from} to ${doc.to}`, 40, 9, 16);
    add(COLUMNS, 40, 7.5, 13, true);
  };

  heading();
  add(`${cell(doc.from, 11)} ${cell('Opening balance', 34)} ${cell('', 16)} ` +
      `${cell('', 15, true)} ${cell('', 15, true)} ${cell(sided(doc.opening), 16, true)}`,
      40, 7.5, 12, true);

  for (const line of doc.lines) {
    if (y < 150) { push(); heading(); }
    add(`${cell(line.voucher_date, 11)} ${cell(line.narration, 34)} ` +
        `${cell(`${line.voucher_type} ${line.voucher_no}`, 16)} ` +
        `${cell(Number(line.debit) ? money(line.debit) : '', 15, true)} ` +
        `${cell(Number(line.credit) ? money(line.credit) : '', 15, true)} ` +
        `${cell(sided(Number(line.running_balance)), 16, true)}`, 40, 7.5, 11);
  }

  if (y < 210) { push(); heading(); }
  y -= 6;
  add(`${cell('', 11)} ${cell('Period total', 34)} ${cell('', 16)} ` +
      `${cell(money(doc.totals.debit), 15, true)} ${cell(money(doc.totals.credit), 15, true)} ` +
      `${cell(sided(doc.closing), 16, true)}`, 40, 8.5, 18, true);

  add(`Closing balance as per our books on ${doc.to}: Rs ${sided(doc.closing)}`, 40, 10, 20, true);
  add('Please confirm the above balance. If it does not agree with your books, return this', 40, 8.5, 12);
  add('letter with your figure and the difference marked, and we will reconcile it with you.', 40, 8.5, 22);

  add('Balance confirmed as per our books:  Rs ______________________  Dr / Cr', 40, 9, 26, true);
  add('Difference, if any: ______________________________________________________', 40, 8.5, 30);
  add('For ' + doc.partyName, 40, 9, 34, true);
  add('Signature: ____________________     Name: ____________________     Date: __________', 40, 8.5, 20);
  add('This statement is from our books. It is not a demand for payment.', 40, 7, 12);
  push();
  return pages;
}

export function renderLedgerConfirmationPdf(doc: ConfirmationDoc): Buffer {
  return renderPages(confirmationPages(doc));
}
