import React, { useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi } from '../lib/useApi';
import { STATUS_LABEL } from '../lib/api';
import { RefreshCw, FileText } from 'lucide-react';

/**
 * One view over every report the API exposes. They differ only in endpoint
 * and column set, so they share a screen instead of one module each.
 */
interface ReportSpec {
  title: string;
  path: string;
  columns: { key: string; label: string; align?: 'right'; format?: (v: any) => string }[];
}

interface EmptyStep { message: string; action: string; module: string }

function emptyStep(report: keyof typeof REPORTS): EmptyStep {
  if (report === 'gstr1_b2b' || report === 'gstr1_cdnr' || report === 'gstr1_hsn' || report === 'gstr3b' || report === 'gst_liability') {
    return {
      message: 'No approved GST documents exist for this period yet.',
      action: 'Open tax invoices', module: 'sales_invoices'
    };
  }
  if (report === 'stock_summary' || report === 'stock_valuation' || report === 'process_stock' || report === 'barcode_history') {
    return {
      message: 'No stock movement has been recorded yet.',
      action: 'Record grey inward', module: 'grey_inward'
    };
  }
  return {
    message: 'No completed documents match this report yet.',
    action: 'Open dashboard', module: 'dashboard'
  };
}

const money = (v: any) => (v == null ? '' : `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);
const num = (v: any) => (v == null ? '' : Number(v).toFixed(2));
const pct = (v: any) => (v == null ? '' : `${Number(v).toFixed(2)}%`);
const status = (v: any) => STATUS_LABEL[v] ?? v ?? '';
const when = (v: any) => (v ? new Date(v).toLocaleString('en-GB') : '');

export const REPORTS: Record<string, ReportSpec> = {
  barcode_history: {
    title: '07] Barcode History — full piece audit trail',
    path: '/reports/barcode-history',
    columns: [
      { key: 'occurred_at', label: 'When', format: when },
      { key: 'barcode', label: 'Barcode' },
      { key: 'lot_no', label: 'Lot' },
      { key: 'quality', label: 'Quality' },
      { key: 'event', label: 'Event' },
      { key: 'from_status', label: 'From', format: status },
      { key: 'to_status', label: 'To', format: status },
      { key: 'qty_after', label: 'Qty', align: 'right', format: num },
      { key: 'counterparty', label: 'Party / Unit' }
    ]
  },
  process_stock: {
    title: '03] Process Stock — lying at dyeing houses',
    path: '/reports/process-stock',
    columns: [
      { key: 'process_house', label: 'Process House' },
      { key: 'stage', label: 'Stage' },
      { key: 'quality', label: 'Quality' },
      { key: 'pcs', label: 'Pcs', align: 'right' },
      { key: 'qty', label: 'Qty (Mtr)', align: 'right', format: num }
    ]
  },
  po_pending: {
    title: '01] Purchase Order Pending',
    path: '/reports/po-pending',
    columns: [
      { key: 'order_no', label: 'Order No' },
      { key: 'order_date', label: 'Date' },
      { key: 'party', label: 'Party' },
      { key: 'quality', label: 'Quality' },
      { key: 'design', label: 'Design' },
      { key: 'qty', label: 'Ordered', align: 'right', format: num },
      { key: 'received_qty', label: 'Received', align: 'right', format: num },
      { key: 'balance_qty', label: 'Balance', align: 'right', format: num },
      { key: 'delay_days', label: 'Delay', align: 'right' }
    ]
  },
  stock_summary: {
    title: '02] Stock Summary — grey and finish on hand',
    path: '/reports/stock-summary',
    columns: [
      { key: 'status', label: 'Stage', format: status },
      { key: 'quality', label: 'Quality' },
      { key: 'grade', label: 'Grade' },
      { key: 'pcs', label: 'Pcs', align: 'right' },
      { key: 'qty', label: 'Qty (Mtr)', align: 'right', format: num }
    ]
  },
  shrinkage: {
    title: '05] Shrinkage by process house',
    path: '/reports/shrinkage',
    columns: [
      { key: 'process_house', label: 'Process House' },
      { key: 'quality', label: 'Quality' },
      { key: 'pieces', label: 'Pieces', align: 'right' },
      { key: 'issued_qty', label: 'Issued', align: 'right', format: num },
      { key: 'received_qty', label: 'Received', align: 'right', format: num },
      { key: 'shrinkage_pct', label: 'Shrinkage', align: 'right', format: pct }
    ]
  },
  gstr1_b2b: {
    title: 'GSTR-1 — B2B outward supplies, by invoice and rate',
    path: '/reports/gstr1-b2b',
    columns: [
      { key: 'return_period', label: 'Period' },
      { key: 'invoice_no', label: 'Invoice' },
      { key: 'invoice_date', label: 'Date' },
      { key: 'recipient_gstin', label: 'Recipient GSTIN' },
      { key: 'recipient_name', label: 'Recipient' },
      { key: 'place_of_supply', label: 'POS' },
      { key: 'gst_rate', label: 'Rate %', align: 'right' },
      { key: 'taxable_value', label: 'Taxable', align: 'right', format: money },
      { key: 'cgst_amount', label: 'CGST', align: 'right', format: money },
      { key: 'sgst_amount', label: 'SGST', align: 'right', format: money },
      { key: 'igst_amount', label: 'IGST', align: 'right', format: money }
    ]
  },
  gstr1_cdnr: {
    title: 'GSTR-1 — Credit / Debit Notes (registered recipients)',
    path: '/reports/gstr1-cdnr',
    columns: [
      { key: 'return_period', label: 'Period' },
      { key: 'note_no', label: 'Note' },
      { key: 'note_kind', label: 'Type' },
      { key: 'note_date', label: 'Date' },
      { key: 'against_invoice', label: 'Original Invoice' },
      { key: 'recipient_gstin', label: 'Recipient GSTIN' },
      { key: 'recipient_name', label: 'Recipient' },
      { key: 'place_of_supply', label: 'POS' },
      { key: 'taxable_value', label: 'Taxable', align: 'right', format: money },
      { key: 'cgst_amount', label: 'CGST', align: 'right', format: money },
      { key: 'sgst_amount', label: 'SGST', align: 'right', format: money },
      { key: 'igst_amount', label: 'IGST', align: 'right', format: money },
      { key: 'note_total', label: 'Total', align: 'right', format: money }
    ]
  },
  gstr1_hsn: {
    title: 'GSTR-1 — HSN summary',
    path: '/reports/gstr1-hsn',
    columns: [
      { key: 'return_period', label: 'Period' },
      { key: 'hsn_code', label: 'HSN' },
      { key: 'uom', label: 'UQC' },
      { key: 'gst_rate', label: 'Rate %', align: 'right' },
      { key: 'total_qty', label: 'Qty', align: 'right', format: num },
      { key: 'taxable_value', label: 'Taxable', align: 'right', format: money },
      { key: 'cgst_amount', label: 'CGST', align: 'right', format: money },
      { key: 'sgst_amount', label: 'SGST', align: 'right', format: money },
      { key: 'igst_amount', label: 'IGST', align: 'right', format: money }
    ]
  },
  gstr3b: {
    title: 'GSTR-3B — 3.1(a) outward taxable supplies',
    path: '/reports/gstr3b-outward',
    columns: [
      { key: 'return_period', label: 'Period' },
      { key: 'invoice_count', label: 'Invoices', align: 'right' },
      { key: 'credit_note_count', label: 'Credit Notes', align: 'right' },
      { key: 'debit_note_count', label: 'Debit Notes', align: 'right' },
      { key: 'taxable_value', label: 'Taxable Value', align: 'right', format: money },
      { key: 'cgst_amount', label: 'CGST', align: 'right', format: money },
      { key: 'sgst_amount', label: 'SGST', align: 'right', format: money },
      { key: 'igst_amount', label: 'IGST', align: 'right', format: money }
    ]
  },
  einvoice_pending: {
    title: 'E-invoice queue — awaiting an IRN',
    path: '/reports/einvoice-pending',
    columns: [
      { key: 'invoice_no', label: 'Invoice' },
      { key: 'invoice_date', label: 'Date' },
      { key: 'party_name', label: 'Party' },
      { key: 'gstin', label: 'GSTIN' },
      { key: 'invoice_total', label: 'Total', align: 'right', format: money },
      { key: 'filing_status', label: 'Status' },
      { key: 'last_error', label: 'Blocking issue' }
    ]
  },
  itc_summary: {
    title: 'Input Tax Credit — by period',
    path: '/reports/itc-summary',
    columns: [
      { key: 'return_period', label: 'Period' },
      { key: 'itc_eligible', label: 'Eligible' },
      { key: 'invoice_count', label: 'Invoices', align: 'right' },
      { key: 'taxable_value', label: 'Taxable', align: 'right', format: money },
      { key: 'cgst_credit', label: 'CGST', align: 'right', format: money },
      { key: 'sgst_credit', label: 'SGST', align: 'right', format: money },
      { key: 'igst_credit', label: 'IGST', align: 'right', format: money }
    ]
  },
  gst_liability: {
    title: 'GST liability — output less input credit',
    path: '/reports/gst-liability',
    columns: [
      { key: 'return_period', label: 'Period' },
      { key: 'output_cgst', label: 'Out CGST', align: 'right', format: money },
      { key: 'credit_cgst', label: 'ITC CGST', align: 'right', format: money },
      { key: 'net_cgst', label: 'Net CGST', align: 'right', format: money },
      { key: 'output_igst', label: 'Out IGST', align: 'right', format: money },
      { key: 'credit_igst', label: 'ITC IGST', align: 'right', format: money },
      { key: 'net_igst', label: 'Net IGST', align: 'right', format: money }
    ]
  },
  trial_balance: {
    title: 'Trial Balance',
    path: '/reports/trial-balance',
    columns: [
      { key: 'code', label: 'Code' },
      { key: 'name', label: 'Ledger' },
      { key: 'control_account', label: 'Control A/c' },
      { key: 'total_debit', label: 'Debit', align: 'right', format: money },
      { key: 'total_credit', label: 'Credit', align: 'right', format: money },
      { key: 'balance', label: 'Balance', align: 'right', format: money }
    ]
  },
  receivable_ageing: {
    title: 'Receivable Ageing',
    path: '/reports/receivable-ageing',
    columns: [
      { key: 'bucket', label: 'Bucket' },
      { key: 'party', label: 'Party' },
      { key: 'invoice_no', label: 'Invoice' },
      { key: 'invoice_date', label: 'Date' },
      { key: 'invoice_total', label: 'Amount', align: 'right', format: money },
      { key: 'credit_days', label: 'Terms', align: 'right' },
      { key: 'age_days', label: 'Age', align: 'right' },
      { key: 'overdue_days', label: 'Overdue', align: 'right' }
    ]
  },
  party_statement: {
    title: 'Party Statement',
    path: '/reports/party-statement',
    columns: [
      { key: 'code', label: 'Code' },
      { key: 'party', label: 'Party' },
      { key: 'voucher_date', label: 'Date' },
      { key: 'voucher_type', label: 'Type' },
      { key: 'voucher_no', label: 'Voucher' },
      { key: 'narration', label: 'Narration' },
      { key: 'debit', label: 'Debit', align: 'right', format: money },
      { key: 'credit', label: 'Credit', align: 'right', format: money },
      { key: 'running_balance', label: 'Balance', align: 'right', format: money }
    ]
  },
  quality_margin: {
    title: 'Margin by quality',
    path: '/reports/quality-margin',
    columns: [
      { key: 'quality', label: 'Quality' },
      { key: 'qty_sold', label: 'Sold', align: 'right', format: num },
      { key: 'revenue', label: 'Revenue', align: 'right', format: money },
      { key: 'grey_cost', label: 'Grey Cost', align: 'right', format: money },
      { key: 'jobwork_cost', label: 'Jobwork', align: 'right', format: money },
      { key: 'margin', label: 'Margin', align: 'right', format: money },
      { key: 'margin_pct', label: 'Margin %', align: 'right', format: pct }
    ]
  },
  weaver_scorecard: {
    title: 'Weaver scorecard',
    path: '/reports/weaver-scorecard',
    columns: [
      { key: 'weaver', label: 'Weaver' },
      { key: 'orders', label: 'Orders', align: 'right' },
      { key: 'ordered_qty', label: 'Ordered', align: 'right', format: num },
      { key: 'received_qty', label: 'Received', align: 'right', format: num },
      { key: 'fill_rate_pct', label: 'Fill Rate', align: 'right', format: pct },
      { key: 'late_lines', label: 'Late Lines', align: 'right' }
    ]
  },
  process_house_scorecard: {
    title: 'Process house scorecard',
    path: '/reports/process-house-scorecard',
    columns: [
      { key: 'process_house', label: 'Process House' },
      { key: 'receipts', label: 'Receipts', align: 'right' },
      { key: 'pieces', label: 'Pieces', align: 'right' },
      { key: 'issued_qty', label: 'Issued', align: 'right', format: num },
      { key: 'received_qty', label: 'Received', align: 'right', format: num },
      { key: 'shrinkage_pct', label: 'Shrinkage', align: 'right', format: pct },
      { key: 'avg_turnaround_days', label: 'Turnaround (d)', align: 'right' }
    ]
  },
  gstr2b_reconciliation: {
    title: 'GSTR-2B reconciliation — portal vs books',
    path: '/reports/gstr2b-reconciliation',
    columns: [
      { key: 'status', label: 'Status' },
      { key: 'return_period', label: 'Period' },
      { key: 'supplier_gstin', label: 'Supplier GSTIN' },
      { key: 'invoice_no', label: 'Invoice' },
      { key: 'invoice_date', label: 'Date' },
      { key: 'portal_taxable', label: 'Portal Taxable', align: 'right', format: money },
      { key: 'books_taxable', label: 'Books Taxable', align: 'right', format: money },
      { key: 'portal_tax', label: 'Portal Tax', align: 'right', format: money },
      { key: 'books_tax', label: 'Books Tax', align: 'right', format: money },
      { key: 'credit_at_risk', label: 'Credit At Risk', align: 'right', format: money }
    ]
  },
  tds_summary: {
    title: 'TDS deducted — by section and party',
    path: '/reports/tds-summary',
    columns: [
      { key: 'fy_label', label: 'FY' },
      { key: 'section_code', label: 'Section' },
      { key: 'party', label: 'Party' },
      { key: 'documents', label: 'Docs', align: 'right' },
      { key: 'base_amount', label: 'Base', align: 'right', format: money },
      { key: 'chargeable', label: 'Chargeable', align: 'right', format: money },
      { key: 'deducted', label: 'Deducted', align: 'right', format: money }
    ]
  },
  stock_valuation: {
    title: 'Stock Valuation — quantity and what it cost',
    path: '/reports/stock-valuation',
    columns: [
      { key: 'status', label: 'Stage', format: status },
      { key: 'quality', label: 'Quality' },
      { key: 'grade', label: 'Grade' },
      { key: 'pcs', label: 'Pcs', align: 'right' },
      { key: 'qty', label: 'Qty (Mtr)', align: 'right', format: num },
      { key: 'grey_cost', label: 'Grey Cost', align: 'right', format: money },
      { key: 'jobwork_cost', label: 'Jobwork', align: 'right', format: money },
      { key: 'total_cost', label: 'Total Cost', align: 'right', format: money },
      { key: 'cost_per_mtr', label: '₹/Mtr', align: 'right', format: num }
    ]
  },
  outstanding_sales: {
    title: 'Outstanding Receivables — bill by bill',
    path: '/reports/outstanding-sales',
    columns: [
      { key: 'party', label: 'Customer' },
      { key: 'invoice_no', label: 'Invoice' },
      { key: 'invoice_date', label: 'Date' },
      { key: 'invoice_total', label: 'Total', align: 'right', format: money },
      { key: 'paid', label: 'Received', align: 'right', format: money },
      { key: 'credited', label: 'Credited', align: 'right', format: money },
      { key: 'outstanding', label: 'Outstanding', align: 'right', format: money },
      { key: 'age_days', label: 'Age', align: 'right' },
      { key: 'overdue_days', label: 'Overdue', align: 'right' }
    ]
  },
  outstanding_purchases: {
    title: 'Outstanding Payables — bill by bill',
    path: '/reports/outstanding-purchases',
    columns: [
      { key: 'party', label: 'Supplier' },
      { key: 'supplier_invoice_no', label: 'Their Invoice' },
      { key: 'our_ref', label: 'Our Ref' },
      { key: 'invoice_date', label: 'Date' },
      { key: 'invoice_total', label: 'Total', align: 'right', format: money },
      { key: 'paid', label: 'Paid', align: 'right', format: money },
      { key: 'outstanding', label: 'Outstanding', align: 'right', format: money },
      { key: 'age_days', label: 'Age', align: 'right' }
    ]
  },
  cash_book: {
    title: 'Cash Book — money in and out',
    path: '/reports/cash-book',
    columns: [
      { key: 'payment_date', label: 'Date' },
      { key: 'voucher_no', label: 'Voucher' },
      { key: 'party', label: 'Party' },
      { key: 'mode', label: 'Mode' },
      { key: 'bank_or_cash', label: 'Account' },
      { key: 'instrument_no', label: 'Reference' },
      { key: 'inflow', label: 'In', align: 'right', format: money },
      { key: 'outflow', label: 'Out', align: 'right', format: money }
    ]
  },
  party_balance: {
    title: '09] Party Balances — from posted vouchers',
    path: '/reports/party-balance',
    columns: [
      { key: 'code', label: 'Code' },
      { key: 'name', label: 'Party' },
      { key: 'balance', label: 'Balance', align: 'right', format: money }
    ]
  }
};

export const LiveReportView: React.FC<{
  report: keyof typeof REPORTS;
  onOpen?: (moduleKey: string) => void;
}> = ({ report, onOpen }) => {
  const spec = REPORTS[report]!;
  const [filter, setFilter] = useState('');
  const { data, error, loading, reload } = useApi<any[]>(spec.path);

  const rows = (data ?? []).filter(r =>
    !filter || Object.values(r).some(v => String(v ?? '').toLowerCase().includes(filter.toLowerCase()))
  );
  const next = emptyStep(report);

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon title={spec.title} onPrint={() => window.print()} />

      <div className="px-3 py-2 flex items-center gap-2 bg-white border-b border-slate-200">
        <FileText className="w-4 h-4 text-blue-700" />
        <input
          value={filter} onChange={e => setFilter(e.target.value)}
          placeholder="Filter any column…" className="erp-input w-72"
        />
        <button onClick={reload} className="erp-btn" title="Reload from server">
          <RefreshCw className="w-3.5 h-3.5 text-blue-600" />
          <span>Refresh</span>
        </button>
        <span className="ml-auto font-semibold text-slate-600">
          {loading ? 'Loading…' : `${rows.length} row${rows.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {error && (
        <div className="bg-red-600 text-white px-4 py-1.5 font-semibold">{error}</div>
      )}

      <div className="flex-1 overflow-auto p-3">
        <table className="w-full bg-white border border-[#b8c9dd]">
          <thead className="bg-slate-100 border-b border-slate-300 sticky top-0">
            <tr>
              {spec.columns.map(c => (
                <th key={c.key}
                    className={`px-2 py-1.5 font-bold ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && (
              <tr><td colSpan={spec.columns.length} className="px-2 py-8 text-center text-slate-500">
                <p>{next.message}</p>
                {onOpen && (
                  <button onClick={() => onOpen(next.module)} className="erp-btn erp-btn-primary mt-3">
                    {next.action}
                  </button>
                )}
              </td></tr>
            )}
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-slate-100 hover:bg-blue-50/40">
                {spec.columns.map(c => (
                  <td key={c.key}
                      className={`px-2 py-1 ${c.align === 'right' ? 'text-right font-mono' : ''}`}>
                    {c.format ? c.format(row[c.key]) : String(row[c.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
