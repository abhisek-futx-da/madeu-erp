import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Grouped navigation. A flat bar worked at nine modules and does not at
 * twenty-five; the legacy system groups the same way on its menu bar.
 */
export interface NavItem { id: string; label: string }
export interface NavGroup { label: string; items: NavItem[] }

export const NAV: NavGroup[] = [
  {
    label: 'Home',
    items: [
      { id: 'dashboard', label: 'Dashboard' },
      { id: 'approvals', label: 'Approvals' },
      { id: 'barcode_history', label: 'Barcode History' },
      { id: 'audit_trail', label: 'Audit Trail' }
    ]
  },
  {
    label: 'Masters',
    items: [
      { id: 'ledgers', label: 'Ledger Accounts' },
      { id: 'qualities', label: 'Quality Master' },
      { id: 'grades', label: 'Grade Master' },
      { id: 'hsn-codes', label: 'HSN / SAC Master' },
      { id: 'units', label: 'Unit Master' },
      { id: 'widths', label: 'Width Master' },
      { id: 'racks', label: 'Rack Master' },
      { id: 'bank-accounts', label: 'Bank Accounts' }
    ]
  },
  {
    label: 'Inventory',
    items: [
      { id: 'sales_orders', label: 'Finish Sales Orders' },
      { id: 'grey_inward', label: 'Grey Inward (Barcoding)' },
      { id: 'dyeing_issue', label: 'Issue To Dyeing' },
      { id: 'dyeing_receipt', label: 'Receive From Dyeing' },
      { id: 'grey_return', label: 'Grey Return To Weaver' },
      { id: 'dyeing_return', label: 'Dyeing Return To Process House' },
      { id: 'customer_return', label: 'Customer Return' },
      { id: 'write_off', label: 'Write-off / Damage' },
      { id: 'cut_pack', label: 'Cut / Pack' },
      { id: 'regroup', label: 'Split / Join Thaan' },
      { id: 'stock_count', label: 'Physical Stock Count' },
      { id: 'delivery_challans', label: 'Delivery Challans (Rule 55)' },
      { id: 'labels', label: 'Barcode Labels' },
      { id: 'dispatch', label: 'Dispatch' }
    ]
  },
  {
    label: 'Accounts',
    items: [
      { id: 'payments', label: 'Receipts & Payments' },
      { id: 'sales_invoices', label: 'Tax Invoices' },
      { id: 'purchase_invoices', label: 'Purchase Invoices' },
      { id: 'gst_notes', label: 'Credit / Debit Notes' },
      { id: 'profit_loss', label: 'Profit & Loss' },
      { id: 'balance_sheet', label: 'Balance Sheet' },
      { id: 'trial_balance', label: 'Trial Balance' },
      { id: 'party_statement', label: 'Party Statement' },
      { id: 'receivable_ageing', label: 'Receivable Ageing' },
      { id: 'outstanding_sales', label: 'Outstanding Receivables' },
      { id: 'outstanding_purchases', label: 'Outstanding Payables' },
      { id: 'party_balance', label: 'Party Balances' },
      { id: 'tds_summary', label: 'TDS Deducted' },
      { id: 'year_close', label: 'Year End Close' }
    ]
  },
  {
    label: 'GST',
    items: [
      { id: 'gstr1_b2b', label: 'GSTR-1 B2B' },
      { id: 'gstr1_cdnr', label: 'GSTR-1 Credit / Debit Notes' },
      { id: 'gstr1_hsn', label: 'GSTR-1 HSN Summary' },
      { id: 'gstr3b', label: 'GSTR-3B Outward' },
      { id: 'itc04', label: 'ITC-04 (job work)' },
      { id: 'eway_bills', label: 'E-Way Bills' },
      { id: 'itc_summary', label: 'Input Tax Credit' },
      { id: 'gst_liability', label: 'Net GST Liability' },
      { id: 'einvoice_pending', label: 'E-invoice Queue' },
      { id: 'gstr2b_reconciliation', label: 'GSTR-2B Reconciliation' }
    ]
  },
  {
    label: 'Reports',
    items: [
      { id: 'audit_trail', label: 'Audit Trail' },
      { id: 'barcode_history', label: 'Barcode History' },
      { id: 'stock_valuation', label: 'Stock Valuation' },
      { id: 'cash_book', label: 'Cash Book' },
      { id: 'stock_summary', label: 'Stock Summary' },
      { id: 'process_stock', label: 'Process Stock' },
      { id: 'po_pending', label: 'PO Pending' },
      { id: 'shrinkage', label: 'Shrinkage' },
      { id: 'quality_margin', label: 'Margin by Quality' },
      { id: 'weaver_scorecard', label: 'Weaver Scorecard' },
      { id: 'process_house_scorecard', label: 'Process House Scorecard' }
    ]
  }
];

interface Props {
  activeModule: string;
  onSelect: (id: string) => void;
}

export const ModuleNav: React.FC<Props> = ({ activeModule, onSelect }) => {
  const [open, setOpen] = useState<string | null>(null);
  const activeGroup = NAV.find(g => g.items.some(i => i.id === activeModule));
  const activeItem = activeGroup?.items.find(i => i.id === activeModule);

  const pick = (id: string) => {
    onSelect(id);
    setOpen(null);
  };

  return (
    <div
      className="bg-[#cbd5e1] border-b border-[#94a3b8] px-3 py-1 flex items-center gap-1 text-xs relative"
      onMouseLeave={() => setOpen(null)}
    >
      {NAV.map(group => {
        const isActive = activeGroup?.label === group.label;
        return (
          <div key={group.label} className="relative">
            <button
              onClick={() => setOpen(open === group.label ? null : group.label)}
              onMouseEnter={() => open && setOpen(group.label)}
              className={`px-3 py-1 rounded font-semibold flex items-center gap-1 transition ${
                isActive
                  ? 'bg-blue-800 text-white'
                  : 'bg-white/80 text-slate-700 hover:bg-white border border-slate-300'
              }`}
            >
              <span>{group.label}</span>
              <ChevronDown className="w-3 h-3" />
            </button>

            {open === group.label && (
              <div className="absolute left-0 top-full mt-0.5 z-40 bg-white border border-slate-400 rounded shadow-lg min-w-56 py-1">
                {group.items.map(item => (
                  <button
                    key={item.id}
                    onClick={() => pick(item.id)}
                    className={`block w-full text-left px-3 py-1.5 hover:bg-blue-50 ${
                      item.id === activeModule ? 'bg-blue-100 font-bold text-blue-900' : 'text-slate-700'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="ml-auto flex items-center gap-2 text-[11px] font-mono font-bold text-blue-950">
        <span>Active:</span>
        <span className="bg-blue-100 text-blue-900 px-2 py-0.5 rounded border border-blue-300">
          {activeItem?.label ?? activeModule}
        </span>
      </div>
    </div>
  );
};
