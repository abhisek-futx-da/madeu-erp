import React, { useEffect, useMemo, useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi } from '../lib/useApi';
import { api, STATUS_LABEL } from '../lib/api';
import { Columns3, Download, FileText, Printer, Save, Sheet, Trash2, RefreshCw } from 'lucide-react';

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
interface SavedView{id:string;name:string;filter_text:string;columns:string[];updated_at:string}

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
  },
  order_lines: {
    title: 'Order Lines With Specification',
    path: '/reports/order-lines',
    columns: [
      { key: 'side', label: 'Side' },
      { key: 'order_date', label: 'Date' },
      { key: 'order_no', label: 'Order' },
      { key: 'party_ref', label: 'Their Ref' },
      { key: 'party', label: 'Party' },
      { key: 'quality', label: 'Quality' },
      { key: 'design', label: 'Design' },
      { key: 'construction', label: 'Construction' },
      { key: 'selvedge_line', label: 'Selvedge' },
      { key: 'width_cms', label: 'Panna (cm)', align: 'right' },
      { key: 'grade_code', label: 'Grade' },
      { key: 'less_type', label: 'Less' },
      { key: 'less_value', label: 'Less Qty', align: 'right', format: num },
      { key: 'pcs', label: 'Pcs', align: 'right' },
      { key: 'cut_length', label: 'Cut', align: 'right', format: num },
      { key: 'qty', label: 'Qty', align: 'right', format: num },
      { key: 'rate', label: 'Rate', align: 'right', format: num },
      { key: 'amount', label: 'Amount', align: 'right', format: money },
      { key: 'balance_qty', label: 'Balance', align: 'right', format: num }
    ]
  },
  cash_and_bank_book: {
    title: 'Cash & Bank Book — every rupee in and out, transfers included',
    path: '/reports/cash-and-bank-book',
    columns: [
      { key: 'entry_date', label: 'Date' },
      { key: 'voucher_no', label: 'Voucher' },
      { key: 'kind', label: 'Kind' },
      { key: 'mode', label: 'Mode' },
      { key: 'account', label: 'Account' },
      { key: 'party', label: 'Party / Other Side' },
      { key: 'instrument_no', label: 'Reference' },
      { key: 'inflow', label: 'In', align: 'right', format: money },
      { key: 'outflow', label: 'Out', align: 'right', format: money },
      { key: 'narration', label: 'Narration' }
    ]
  },
  sales_register: {
    title: 'Sales Register — every bill raised, in date order',
    path: '/reports/sales-register',
    columns: [
      { key: 'invoice_date', label: 'Date' },
      { key: 'invoice_no', label: 'Invoice' },
      { key: 'party', label: 'Customer' },
      { key: 'party_gstin', label: 'GSTIN' },
      { key: 'place_of_supply', label: 'POS' },
      { key: 'taxable_value', label: 'Taxable', align: 'right', format: money },
      { key: 'tax_amount', label: 'GST', align: 'right', format: money },
      { key: 'round_off', label: 'Round Off', align: 'right', format: money },
      { key: 'invoice_total', label: 'Bill Total', align: 'right', format: money },
      { key: 'broker', label: 'Broker' },
      { key: 'brokerage_amount', label: 'Brokerage', align: 'right', format: money },
      { key: 'irn', label: 'IRN' },
      { key: 'status', label: 'Status', format: status }
    ]
  },
  purchase_register: {
    title: 'Purchase Register — every supplier bill, in date order',
    path: '/reports/purchase-register',
    columns: [
      { key: 'invoice_date', label: 'Date' },
      { key: 'supplier_invoice_no', label: 'Their Invoice' },
      { key: 'our_ref', label: 'Our Ref' },
      { key: 'party', label: 'Supplier' },
      { key: 'party_gstin', label: 'GSTIN' },
      { key: 'taxable_value', label: 'Taxable', align: 'right', format: money },
      { key: 'tax_amount', label: 'GST', align: 'right', format: money },
      { key: 'invoice_total', label: 'Bill Total', align: 'right', format: money },
      { key: 'broker', label: 'Broker' },
      { key: 'itc_eligible', label: 'ITC' },
      { key: 'status', label: 'Status', format: status }
    ]
  },
  day_book: {
    title: 'Day Book — every posted entry, both legs',
    path: '/reports/day-book',
    columns: [
      { key: 'voucher_date', label: 'Date' },
      { key: 'voucher_type', label: 'Type' },
      { key: 'voucher_no', label: 'Voucher' },
      { key: 'ledger_code', label: 'Code' },
      { key: 'ledger', label: 'Ledger' },
      { key: 'control_account', label: 'Group' },
      { key: 'debit', label: 'Debit', align: 'right', format: money },
      { key: 'credit', label: 'Credit', align: 'right', format: money },
      { key: 'narration', label: 'Narration' }
    ]
  },
  trial_balance_grouped: {
    title: 'Trial Balance By Group — the same figures by head',
    path: '/reports/trial-balance-grouped',
    columns: [
      { key: 'nature', label: 'Nature' },
      { key: 'sub_control', label: 'Sub Head' },
      { key: 'control_account', label: 'Group' },
      { key: 'ledgers', label: 'Ledgers', align: 'right' },
      { key: 'total_debit', label: 'Debit', align: 'right', format: money },
      { key: 'total_credit', label: 'Credit', align: 'right', format: money },
      { key: 'balance', label: 'Balance', align: 'right', format: money }
    ]
  }
};

interface Catalogue { name: string; hasPeriod: boolean; totals: string[]; groupBy: string | null }
interface Group { label: string; rows: number; totals: Record<string, number> }
interface Summary { total: number; totals: Record<string, number>; groups?: Group[] }

const PAGE = 200;

export const LiveReportView: React.FC<{
  report: keyof typeof REPORTS;
  onOpen?: (moduleKey: string) => void;
}> = ({ report, onOpen }) => {
  const spec = REPORTS[report]!;
  /** The API's own name for this report, which the catalogue is keyed on. */
  const reportName = spec.path.replace('/reports/', '');
  const [filter, setFilter] = useState('');
  const [applied, setApplied] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [visible,setVisible]=useState<string[]>(()=>spec.columns.map(column=>column.key));
  const [viewName,setViewName]=useState('');
  const [selectedView,setSelectedView]=useState('');
  const [message,setMessage]=useState('');
  const catalogue = useApi<Catalogue[]>('/report-catalogue');
  const meta = (catalogue.data ?? []).find(entry => entry.name === reportName);
  const period = meta?.hasPeriod ?? false;
  const groupBy = meta?.groupBy ?? null;

  /**
   * The search is a server query, not a pass over what is already on screen:
   * the old box filtered the fetched page and answered confidently from a
   * fraction of the report. Debounced, so typing is one query, not one each.
   */
  useEffect(() => {
    const timer = setTimeout(() => { setApplied(filter.trim()); setOffset(0); }, 300);
    return () => clearTimeout(timer);
  }, [filter]);

  const scope = useMemo(() => {
    const p = new URLSearchParams();
    if (applied) p.set('q', applied);
    if (period && from) p.set('from', from);
    if (period && to) p.set('to', to);
    const text = p.toString();
    return text ? `${text}&` : '';
  }, [applied, period, from, to]);

  const { data, error, loading, reload } =
    useApi<any[]>(`${spec.path}?${scope}limit=${PAGE}&offset=${offset}`);
  const summary = useApi<Summary>(`${spec.path}/summary?${scope}`);
  const saved=useApi<SavedView[]>(`/saved-views?module=${encodeURIComponent(`report:${report}`)}`);

  useEffect(()=>{setFilter('');setApplied('');setFrom('');setTo('');setOffset(0);setVisible(spec.columns.map(column=>column.key));setSelectedView('');setViewName('');setMessage('');},[report,spec]);

  const rows = data ?? [];
  const total = summary.data?.total ?? rows.length;
  const totals = summary.data?.totals ?? {};
  /** "TOTAL OF Bombay Crimpers Pvt. Ltd." — subtotals over the whole report. */
  const groups = new Map((summary.data?.groups ?? []).map(g => [g.label, g] as const));
  const next = emptyStep(report);
  const columns=useMemo(()=>spec.columns.filter(column=>visible.includes(column.key)),[spec.columns,visible]);
  const applyView=(id:string)=>{setSelectedView(id);const view=(saved.data??[]).find(row=>row.id===id);if(!view)return;setFilter(view.filter_text);const allowed=view.columns.filter(key=>spec.columns.some(column=>column.key===key));setVisible(allowed.length?allowed:spec.columns.map(column=>column.key));setViewName(view.name);setMessage(`Loaded ${view.name}`);};
  const saveView=async()=>{const name=viewName.trim();if(!name||columns.length===0)return;await api.post('/saved-views',{module:`report:${report}`,name,filterText:filter,columns:columns.map(column=>column.key)});saved.reload();setMessage(`Saved ${name} for your account`);};
  const deleteView=async()=>{if(!selectedView)return;await api.del(`/saved-views/${selectedView}`);saved.reload();setSelectedView('');setViewName('');setMessage('Saved report deleted');};

  /** The file is the whole report under these filters, not the page on screen. */
  const take = async (format: 'csv' | 'pdf' | 'xlsx') => {
    setMessage(`Preparing the ${format.toUpperCase()}…`);
    try {
      await api.download(
        `${spec.path}?${scope}format=${format}` +
        `&columns=${encodeURIComponent(columns.map(column => column.key).join(','))}`, reportName);
      setMessage(`${format.toUpperCase()} downloaded — ${total} row${total === 1 ? '' : 's'}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'the export failed');
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon title={spec.title}
        onPrint={() => void take('pdf')} onExport={() => void take('xlsx')} />

      <div className="px-3 py-2 flex flex-wrap items-center gap-2 bg-white border-b border-slate-200">
        <FileText className="w-4 h-4 text-blue-700" />
        <input
          value={filter} onChange={e => setFilter(e.target.value)} aria-label="Search this report"
          placeholder="Search the whole report…" className="erp-input w-60 min-h-11"
        />
        {period ? (
          <>
            <label htmlFor="report-from">From</label>
            <input id="report-from" type="date" aria-label="From date"
              className="erp-input min-h-11"
              value={from} onChange={e => { setFrom(e.target.value); setOffset(0); }} />
            <label htmlFor="report-to">To</label>
            <input id="report-to" type="date" aria-label="To date"
              className="erp-input min-h-11"
              value={to} onChange={e => { setTo(e.target.value); setOffset(0); }} />
          </>
        ) : (
          <span className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-slate-600">
            Position as on today — no date range applies
          </span>
        )}
        <button onClick={reload} className="erp-btn min-h-11" title="Reload from server">
          <RefreshCw className="w-3.5 h-3.5 text-blue-600" />
          <span>Refresh</span>
        </button>
        <details className="relative"><summary className="erp-btn min-h-11 cursor-pointer list-none"><Columns3 className="h-4 w-4"/>Columns ({columns.length}/{spec.columns.length})</summary><div className="absolute left-0 z-20 mt-1 grid min-w-64 gap-1 rounded border bg-white p-3 shadow-xl">{spec.columns.map(column=><label key={column.key} className="flex min-h-9 items-center gap-2"><input type="checkbox" checked={visible.includes(column.key)} onChange={event=>setVisible(current=>event.target.checked?[...current,column.key]:current.length===1?current:current.filter(key=>key!==column.key))}/>{column.label}</label>)}</div></details>
        <span className="ml-auto font-semibold text-slate-600">
          {loading ? 'Loading…' : total > rows.length
            ? `${offset + 1}–${offset + rows.length} of ${total}`
            : `${total} row${total === 1 ? '' : 's'}`}
        </span>
        <button className="erp-btn min-h-11" disabled={offset === 0}
          onClick={() => setOffset(current => Math.max(0, current - PAGE))}>Previous</button>
        <button className="erp-btn min-h-11" disabled={offset + rows.length >= total}
          onClick={() => setOffset(current => current + PAGE)}>Next</button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b bg-blue-50 px-3 py-2"><FileText className="h-4 w-4 text-blue-800"/><strong>My saved reports</strong><select aria-label="Saved report" className="erp-input min-h-11 min-w-48" value={selectedView} onChange={e=>applyView(e.target.value)}><option value="">Choose saved report</option>{(saved.data??[]).map(view=><option key={view.id} value={view.id}>{view.name}</option>)}</select><input aria-label="Saved report name" className="erp-input min-h-11 w-56" placeholder="Name this filter and layout" value={viewName} onChange={e=>setViewName(e.target.value)}/><button disabled={!viewName.trim()} className="erp-btn erp-btn-primary min-h-11" onClick={()=>void saveView()}><Save className="h-4 w-4"/>Save current</button><button disabled={!selectedView} className="erp-btn min-h-11" onClick={()=>void deleteView()}><Trash2 className="h-4 w-4 text-red-700"/>Delete</button><button className="erp-btn min-h-11" onClick={()=>void take('xlsx')}><Sheet className="h-4 w-4"/>Excel</button><button className="erp-btn min-h-11" onClick={()=>void take('csv')}><Download className="h-4 w-4"/>CSV</button><button className="erp-btn min-h-11" onClick={()=>void take('pdf')}><Printer className="h-4 w-4"/>Print PDF</button>{message&&<span role="status" className="font-semibold text-emerald-800">{message}</span>}</div>

      {error && (
        <div className="bg-red-600 text-white px-4 py-1.5 font-semibold">{error}</div>
      )}

      <div className="flex-1 overflow-auto p-3">
        <table className="w-full bg-white border border-[#b8c9dd]">
          <thead className="bg-slate-100 border-b border-slate-300 sticky top-0">
            <tr>
              {columns.map(c => (
                <th key={c.key}
                    className={`px-2 py-1.5 font-bold ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && (
              <tr><td colSpan={columns.length} className="px-2 py-8 text-center text-slate-500">
                <p>{next.message}</p>
                {onOpen && (
                  <button onClick={() => onOpen(next.module)} className="erp-btn erp-btn-primary mt-3">
                    {next.action}
                  </button>
                )}
              </td></tr>
            )}
            {rows.map((row, i) => {
              // A subtotal closes each break, the way a mill's own reports read.
              const label = groupBy ? String(row[groupBy] ?? '(none)') : null;
              const last = groupBy && (i === rows.length - 1
                || String(rows[i + 1]?.[groupBy] ?? '(none)') !== label);
              const group = last && label !== null ? groups.get(label) : undefined;
              return (
                <React.Fragment key={i}>
                  <tr className="border-b border-slate-100 hover:bg-blue-50/40">
                    {columns.map(c => (
                      <td key={c.key}
                          className={`px-2 py-1 ${c.align === 'right' ? 'text-right font-mono' : ''}`}>
                        {c.format ? c.format(row[c.key]) : String(row[c.key] ?? '')}
                      </td>
                    ))}
                  </tr>
                  {group && (
                    <tr className="border-y border-slate-300 bg-slate-50 font-bold">
                      {columns.map((c, at) => (
                        <td key={c.key}
                            className={`px-2 py-1 ${c.align === 'right' ? 'text-right font-mono' : ''}`}>
                          {at === 0 ? `TOTAL OF ${label}`
                            : c.key in group.totals
                              ? (c.format ?? num)(group.totals[c.key]) : ''}
                        </td>
                      ))}
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
          {rows.length > 0 && Object.keys(totals).length > 0 && (
            /* The footer totals the whole report under these filters. Adding up
               the page on screen would state a total for one screenful. */
            <tfoot className="sticky bottom-0 border-t-2 border-slate-400 bg-slate-100 font-bold">
              <tr>
                {columns.map((c, i) => (
                  <td key={c.key}
                      className={`px-2 py-1.5 ${c.align === 'right' ? 'text-right font-mono' : ''}`}>
                    {i === 0
                      ? `Total (${total} row${total === 1 ? '' : 's'})`
                      : c.key in totals ? (c.format ?? num)(totals[c.key]) : ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
};
