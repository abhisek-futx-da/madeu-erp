import { many, type Db } from './db.ts';
import { whereFor, type ListQuery, type ListSpec } from './listing.ts';

/**
 * Every report used to be `select * from <view> limit 500` — no period, no
 * search, no order, and therefore no total. A mill owner cannot ask "shrinkage
 * for August" of a report that has never heard of August, and offset paging
 * without an ORDER BY silently repeats and skips rows.
 *
 * One registry gives all of them a period, a search, a stable order and a
 * footer total, instead of thirty near-identical route handlers.
 */
export interface ReportSpec extends ListSpec {
  title: string;
  /**
   * Columns a total is arithmetically meaningful for. Percentages, running
   * balances and ageing days are excluded on purpose: summing them produces a
   * number that looks authoritative and means nothing.
   */
  numeric: string[];
  /**
   * The column a reader wants subtotals by — "TOTAL OF Bombay Crimpers Pvt.
   * Ltd." A flat list with one figure at the bottom is not how anyone reads a
   * report covering eleven process houses. The order always leads with this
   * column, or the groups would be interleaved and the subtotals nonsense.
   */
  groupBy?: string;
}

const spec = (
  view: string,
  title: string,
  o: {
    date?: string; search?: string[]; order: string;
    numeric?: string[]; groupBy?: string;
  }
): ReportSpec => ({
  from: view,
  select: '*',
  title,
  dateColumn: o.date,
  search: o.search ?? [],
  orderBy: o.order,
  numeric: o.numeric ?? [],
  groupBy: o.groupBy
});

export const REPORTS: Record<string, ReportSpec> = {
  // ------------------------------------------------------------- movement --
  'barcode-history': spec('v_barcode_history', 'Barcode History', {
    date: 'occurred_at',
    search: ['barcode', 'lot_no', 'quality', 'counterparty', 'event'],
    order: 'occurred_at desc, barcode'
    // qty_after is a piece's state at a moment; adding those up means nothing.
  }),
  'piece-lineage': spec('v_piece_lineage', 'Split / Join Lineage', {
    date: 'entry_date',
    search: ['entry_no', 'from_barcode', 'to_barcode', 'reason'],
    order: 'entry_date desc, entry_no',
    numeric: ['qty', 'cost']
  }),
  'piece-drift': spec('v_piece_drift', 'Piece Fold Drift', {
    search: ['barcode'], order: 'barcode'
  }),
  'regroup-imbalance': spec('v_regroup_imbalance', 'Split / Join Imbalance', {
    search: ['entry_no', 'kind'], order: 'entry_no',
    numeric: ['lineage_qty', 'consumed_qty', 'produced_qty', 'loss_qty']
  }),

  // -------------------------------------------------------------- position --
  'stock-summary': spec('v_stock_summary', 'Stock Summary', {
    search: ['quality', 'grade', 'status'], order: 'quality, grade, status',
    groupBy: 'quality',
    numeric: ['pcs', 'qty', 'weight_kg']
  }),
  'stock-valuation': spec('v_stock_valuation', 'Stock Valuation', {
    search: ['quality', 'grade', 'status'], order: 'quality, grade, status',
    groupBy: 'quality',
    numeric: ['pcs', 'qty', 'grey_cost', 'jobwork_cost', 'total_cost']
    // cost_per_mtr is a ratio; the footer derives it from the totals instead.
  }),
  'process-stock': spec('v_process_stock', 'Process Stock', {
    search: ['process_house', 'quality', 'stage'], order: 'process_house, quality',
    groupBy: 'process_house',
    numeric: ['pcs', 'qty', 'weight_kg']
  }),
  'order-lines': spec('v_order_line_spec', 'Order Lines With Specification', {
    date: 'order_date',
    search: ['order_no', 'party_ref', 'party', 'quality', 'design', 'construction',
             'selvedge_line', 'grade_code', 'side'],
    order: 'party, order_date, order_no, sno',
    groupBy: 'party',
    numeric: ['pcs', 'qty', 'amount', 'done_qty', 'balance_qty', 'less_value']
  }),
  'po-pending': spec('v_po_pending', 'Purchase Order Pending', {
    date: 'order_date',
    search: ['order_no', 'party', 'quality', 'design'],
    order: 'order_date desc, order_no',
    numeric: ['qty', 'received_qty', 'balance_qty']
  }),

  // ------------------------------------------------------------ stock count --
  'stock-count-summary': spec('v_stock_count_summary', 'Stock Count Summary', {
    date: 'count_date',
    search: ['count_no', 'rack_code', 'quality', 'lot_no', 'counted_by', 'reason'],
    order: 'count_date desc, count_no',
    numeric: ['pieces_expected', 'pieces_counted', 'variances',
              'loss_value', 'gain_value', 'net_value']
  }),
  'stock-count-variance': spec('v_stock_count_variance', 'Stock Count Variance', {
    date: 'count_date',
    search: ['count_no', 'barcode', 'quality', 'lot_no', 'reason', 'kind'],
    order: 'count_no, barcode',
    groupBy: 'count_no',
    numeric: ['system_qty', 'counted_qty', 'value']
  }),

  // ------------------------------------------------------------- performance --
  shrinkage: spec('v_shrinkage_by_process_house', 'Shrinkage By Process House', {
    search: ['process_house', 'quality'], order: 'process_house, quality',
    groupBy: 'process_house',
    numeric: ['pieces', 'issued_qty', 'received_qty',
              'issued_weight_kg', 'received_weight_kg']
    // shrinkage_pct is a ratio of the totals, not a sum of the ratios.
  }),
  'quality-margin': spec('v_quality_margin', 'Margin By Quality', {
    search: ['quality'], order: 'quality',
    numeric: ['qty_sold', 'revenue', 'grey_cost', 'jobwork_cost', 'margin']
  }),
  'weaver-scorecard': spec('v_weaver_scorecard', 'Weaver Scorecard', {
    search: ['weaver'], order: 'weaver',
    numeric: ['orders', 'ordered_qty', 'received_qty', 'late_lines']
  }),
  'process-house-scorecard': spec('v_process_house_scorecard', 'Process House Scorecard', {
    search: ['process_house'], order: 'process_house',
    groupBy: 'process_house',
    numeric: ['receipts', 'pieces', 'issued_qty', 'received_qty']
  }),

  // ---------------------------------------------------------------- accounts --
  'unbilled-receipts': spec('v_unbilled_receipts', 'Received But Not Billed', {
    date: 'entry_date',
    search: ['entry_no', 'challan_no', 'party', 'party_code', 'kind'],
    order: 'party, entry_date, entry_no',
    groupBy: 'party',
    numeric: ['received_value', 'billed_value', 'unbilled_value']
  }),
  'double-booked-purchases': spec('v_double_booked_purchases', 'Bills Booked Twice (Before The Fix)', {
    date: 'invoice_date',
    search: ['our_ref', 'supplier_invoice_no', 'party', 'voucher_no'],
    order: 'invoice_date, our_ref',
    numeric: ['billed_twice_value']
  }),
  'sales-register': spec('v_sales_register', 'Sales Register', {
    date: 'invoice_date',
    search: ['invoice_no', 'party', 'party_code', 'party_gstin', 'voucher_no', 'status', 'broker'],
    order: 'party, invoice_date, invoice_no',
    groupBy: 'party',
    numeric: ['taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount',
              'tax_amount', 'round_off', 'invoice_total', 'brokerage_amount']
  }),
  'purchase-register': spec('v_purchase_register', 'Purchase Register', {
    date: 'invoice_date',
    search: ['our_ref', 'supplier_invoice_no', 'party', 'party_code', 'party_gstin', 'status', 'broker'],
    order: 'party, invoice_date, our_ref',
    groupBy: 'party',
    numeric: ['taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount',
              'tax_amount', 'round_off', 'invoice_total']
  }),
  'day-book': spec('v_day_book', 'Day Book', {
    date: 'voucher_date',
    search: ['voucher_no', 'voucher_type', 'ledger', 'ledger_code',
             'control_account', 'narration'],
    order: 'voucher_date, voucher_no, ledger_code',
    numeric: ['debit', 'credit']
  }),
  'trial-balance': spec('v_trial_balance', 'Trial Balance', {
    search: ['code', 'name', 'control_account'], order: 'control_account, code',
    groupBy: 'control_account',
    numeric: ['total_debit', 'total_credit']
    // balance nets to zero across the whole report and says nothing in a footer.
  }),
  'trial-balance-grouped': spec('v_trial_balance_grouped', 'Trial Balance By Group', {
    search: ['control_account', 'sub_control', 'nature'],
    order: 'nature, sub_control, control_account',
    numeric: ['ledgers', 'total_debit', 'total_credit']
  }),
  'party-balance': spec('v_party_balance', 'Party Balances', {
    search: ['code', 'name'], order: 'name',
    numeric: ['balance']
  }),
  'party-statement': spec('v_party_statement', 'Party Statement', {
    date: 'voucher_date',
    search: ['code', 'party', 'voucher_no', 'voucher_type', 'narration'],
    order: 'party, voucher_date, voucher_no',
    groupBy: 'party',
    numeric: ['debit', 'credit']
    // running_balance is cumulative; the ledger report carries the opening.
  }),
  'cash-and-bank-book': spec('v_cash_and_bank_book', 'Cash & Bank Book', {
    date: 'entry_date',
    search: ['voucher_no', 'party', 'account', 'instrument_no', 'narration', 'kind', 'mode'],
    order: 'account, entry_date, voucher_no',
    groupBy: 'account',
    numeric: ['inflow', 'outflow']
  }),
  'contra-entries': spec('v_contra_entry', 'Contra Entries', {
    date: 'entry_date',
    search: ['entry_no', 'from_account', 'to_account', 'instrument_no', 'narration'],
    order: 'entry_date, entry_no',
    numeric: ['amount']
  }),
  'cash-book': spec('v_cash_book', 'Cash Book', {
    date: 'payment_date',
    search: ['voucher_no', 'party', 'bank_or_cash', 'instrument_no', 'narration', 'mode'],
    order: 'payment_date desc, voucher_no',
    numeric: ['inflow', 'outflow']
  }),
  'outstanding-sales': spec('v_outstanding_sales', 'Outstanding Receivables', {
    date: 'invoice_date',
    search: ['code', 'party', 'invoice_no'],
    order: 'party, invoice_date, invoice_no',
    groupBy: 'party',
    numeric: ['invoice_total', 'paid', 'credited', 'outstanding']
  }),
  'outstanding-purchases': spec('v_outstanding_purchases', 'Outstanding Payables', {
    date: 'invoice_date',
    search: ['party', 'supplier_invoice_no', 'our_ref'],
    order: 'party, invoice_date',
    groupBy: 'party',
    numeric: ['invoice_total', 'paid', 'outstanding']
  }),
  'receivable-ageing': spec('v_receivable_ageing', 'Receivable Ageing', {
    date: 'invoice_date',
    search: ['code', 'party', 'invoice_no', 'bucket'],
    order: 'bucket, party, invoice_date',
    groupBy: 'bucket',
    numeric: ['invoice_total']
  }),
  'tds-summary': spec('v_tds_summary', 'TDS Deducted', {
    search: ['party', 'section_code', 'fy_label'],
    order: 'fy_label desc, section_code, party',
    numeric: ['documents', 'base_amount', 'chargeable', 'deducted']
  }),

  // --------------------------------------------------------------------- GST --
  'gstr1-b2b': spec('v_gstr1_b2b', 'GSTR-1 B2B', {
    date: 'invoice_date',
    search: ['invoice_no', 'recipient_name', 'recipient_gstin', 'return_period'],
    order: 'invoice_date, invoice_no, gst_rate',
    numeric: ['taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount']
  }),
  'gstr1-cdnr': spec('v_gstr1_cdnr', 'GSTR-1 Credit / Debit Notes', {
    date: 'note_date',
    search: ['note_no', 'recipient_name', 'recipient_gstin', 'against_invoice'],
    order: 'note_date, note_no',
    numeric: ['taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'note_total']
  }),
  'gstr1-hsn': spec('v_gstr1_hsn', 'GSTR-1 HSN Summary', {
    search: ['hsn_code', 'uom', 'return_period'],
    order: 'return_period desc, hsn_code, gst_rate',
    numeric: ['total_qty', 'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount']
  }),
  'gstr3b-outward': spec('v_gstr3b_outward', 'GSTR-3B Outward', {
    search: ['return_period'], order: 'return_period desc',
    numeric: ['invoice_count', 'credit_note_count', 'debit_note_count',
              'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount']
  }),
  'einvoice-pending': spec('v_einvoice_pending', 'E-invoice Queue', {
    date: 'invoice_date',
    search: ['invoice_no', 'party_name', 'gstin', 'filing_status'],
    order: 'invoice_date, invoice_no',
    numeric: ['invoice_total']
  }),
  'itc-summary': spec('v_itc_summary', 'Input Tax Credit', {
    search: ['return_period', 'itc_eligible'], order: 'return_period desc',
    numeric: ['invoice_count', 'taxable_value', 'cgst_credit', 'sgst_credit', 'igst_credit']
  }),
  'gst-liability': spec('v_gst_liability', 'Net GST Liability', {
    search: ['return_period'], order: 'return_period desc',
    numeric: ['output_cgst', 'credit_cgst', 'net_cgst',
              'output_igst', 'credit_igst', 'net_igst']
  }),
  'gstr2b-reconciliation': spec('v_gstr2b_reconciliation', 'GSTR-2B Reconciliation', {
    date: 'invoice_date',
    search: ['supplier_gstin', 'invoice_no', 'status', 'return_period'],
    order: 'return_period desc, supplier_gstin, invoice_no',
    numeric: ['portal_taxable', 'books_taxable', 'portal_tax', 'books_tax', 'credit_at_risk']
  })
};

/**
 * A page of the report. Deliberately not `paged()`: that runs a COUNT beside
 * every page, and the rows endpoint throws the count away — the footer is a
 * separate request precisely so scrolling does not re-aggregate the report.
 */
export async function reportRows(
  db: Db, report: ReportSpec, q: ListQuery
): Promise<Record<string, unknown>[]> {
  const { where, params } = whereFor(report, q);
  params.push(q.limit, q.offset);
  return many<Record<string, unknown>>(
    db,
    `select * from ${report.from} ${where}
      order by ${report.orderBy} limit $${params.length - 1} offset $${params.length}`,
    params
  );
}

export interface ReportGroup {
  label: string;
  rows: number;
  totals: Record<string, number>;
}

export interface ReportTotals {
  /** Rows in the whole filtered report, not in the page on screen. */
  total: number;
  totals: Record<string, number>;
  /** Subtotals by the report's own grouping column, where it has one. */
  groups?: ReportGroup[];
}

/**
 * Subtotals per group, over the whole filtered report. Capped: a report that
 * groups into thousands is not one anybody reads by group, and returning a
 * subtotal per row would be slower and less useful than the rows themselves.
 */
const MAX_GROUPS = 500;

export async function reportGroups(
  db: Db, report: ReportSpec, q: ListQuery
): Promise<ReportGroup[] | undefined> {
  if (!report.groupBy || report.numeric.length === 0) return undefined;
  const { where, params } = whereFor(report, q);
  const sums = report.numeric.map(c => `coalesce(sum(${c}), 0)::float8 as ${c}`).join(', ');
  const rows = await many<Record<string, unknown>>(
    db,
    `select coalesce(${report.groupBy}::text, '(none)') as group_label,
            count(*)::int as group_rows, ${sums}
       from ${report.from} ${where}
      group by 1 order by 1 limit ${MAX_GROUPS + 1}`,
    params
  );
  if (rows.length > MAX_GROUPS) return undefined;
  return rows.map(row => ({
    label: String(row.group_label),
    rows: Number(row.group_rows),
    totals: Object.fromEntries(report.numeric.map(c => [c, Number(row[c] ?? 0)]))
  }));
}

/**
 * Totals over every row the filter selects, which is the only total worth
 * printing: a footer that adds up the visible page tells the reader what one
 * screen happens to contain.
 */
export async function reportTotals(
  db: Db, report: ReportSpec, q: ListQuery
): Promise<ReportTotals> {
  const { where, params } = whereFor(report, q);
  const sums = report.numeric
    .map(c => `coalesce(sum(${c}), 0)::float8 as ${c}`)
    .join(', ');
  const rows = await many<Record<string, number>>(
    db,
    `select count(*)::int as row_count${sums ? `, ${sums}` : ''} from ${report.from} ${where}`,
    params
  );
  const row = rows[0] ?? {};
  const totals: Record<string, number> = {};
  for (const c of report.numeric) totals[c] = Number(row[c] ?? 0);
  return {
    total: Number(row.row_count ?? 0),
    totals,
    groups: await reportGroups(db, report, q)
  };
}

/** What the screens need to know before they can offer the right controls. */
export function reportCatalogue() {
  return Object.entries(REPORTS).map(([name, r]) => ({
    name,
    title: r.title,
    /** False for a position as on today; the screen hides its date boxes. */
    hasPeriod: Boolean(r.dateColumn),
    searchable: r.search.length > 0,
    totals: r.numeric,
    /** The column subtotals break on, so a screen can label them. */
    groupBy: r.groupBy ?? null
  }));
}
