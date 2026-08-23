import React, { useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { usePagedList } from '../lib/usePagedList';
import { ListControls } from '../components/ListControls';
import { useApi, useSubmit } from '../lib/useApi';
import { api, ApiError, type LedgerRow } from '../lib/api';
import { AlertTriangle, CheckCircle2, Wallet, Wand2, XCircle, Plus, Trash2 } from 'lucide-react';

interface PaymentRow {
  id: string; voucher_no: string; kind: 'receipt' | 'payment'; payment_date: string;
  mode: string; instrument_no: string | null; amount: number; discount: number;
  allocated: number; narration: string; status: string;
  party_name: string; bank_name: string | null;
}

interface Outstanding {
  invoice_id: string; invoice_no?: string; our_ref?: string;
  invoice_date: string; party: string; code: string;
  invoice_total: number; paid: number; outstanding: number; overdue_days?: number;
}

interface Alloc { invoiceId: string; label: string; amount: number }
interface Deduction {
  invoiceId: string; label: string;
  kind: 'cash_discount' | 'quality_discount' | 'rate_difference' | 'shortage' | 'tds' | 'other';
  amount: number; reason: string;
  taxTreatment: 'none' | 'credit_note_required' | 'debit_note_required';
}

const money = (v: number) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Receipts and payments. Until this screen existed a party balance could only
 * grow: the system could invoice a customer and never record that they paid.
 */
export const PaymentView: React.FC = () => {
  const [kind, setKind] = useState<'receipt' | 'payment'>('receipt');
  const [partyId, setPartyId] = useState('');
  const [paymentDate, setPaymentDate] = useState(today());
  const [mode, setMode] = useState<'cash' | 'cheque' | 'neft' | 'rtgs' | 'upi'>('neft');
  const [amount, setAmount] = useState(0);
  const [discount, setDiscount] = useState(0);
  const [instrumentNo, setInstrumentNo] = useState('');
  const [bankLedgerId, setBankLedgerId] = useState('');
  const [narration, setNarration] = useState('');
  const [allocs, setAllocs] = useState<Alloc[]>([]);
  const [deductions, setDeductions] = useState<Deduction[]>([]);
  const [deductionInvoice, setDeductionInvoice] = useState('');
  const [deductionKind, setDeductionKind] = useState<Deduction['kind']>('cash_discount');
  const [deductionAmount, setDeductionAmount] = useState(0);
  const [deductionReason, setDeductionReason] = useState('');
  const [taxTreatment, setTaxTreatment] = useState<Deduction['taxTreatment']>('none');
  const [notice, setNotice] = useState<string | null>(null);

  const ledgers = useApi<LedgerRow[]>('/ledgers');
  const controls = useApi<{ id: string; nature: string }[]>('/control-accounts');
  const payments = usePagedList<PaymentRow>('/payments');
  const outstanding = useApi<Outstanding[]>(
    partyId ? `/reports/${kind === 'receipt' ? 'outstanding-sales' : 'outstanding-purchases'}` : null,
    [partyId, kind]
  );
  const { submit, busy, error } = useSubmit<unknown, any>('/payments');

  const partyCode = (ledgers.data ?? []).find(l => l.id === partyId)?.code;
  const partyBills = (outstanding.data ?? [])
    .filter(o => o.code === partyCode && Number(o.outstanding) > 0.005);
  const totalDue = partyBills.reduce((n, o) => n + Number(o.outstanding), 0);
  const allocated = allocs.reduce((n, a) => n + a.amount, 0);
  const deducted = deductions.reduce((n, deduction) => n + deduction.amount, 0);
  const onAccount = Math.round((amount + discount + deducted - allocated) * 100) / 100;

  // Money moves between us and a party, never an internal posting account, so
  // the picker offers debtors and creditors only.
  const PARTY_NATURES = new Set([
    'sundry_debtor_finish', 'sundry_creditor_grey', 'sundry_creditor_process',
    'sundry_creditor_finish', 'sundry_creditor_brokerage',
    'sundry_creditor_transport', 'sundry_creditor_expense'
  ]);
  const partyControlIds = new Set(
    (controls.data ?? []).filter(c => PARTY_NATURES.has(c.nature)).map(c => c.id)
  );
  const parties = (ledgers.data ?? []).filter(l => partyControlIds.has(l.control_account_id));

  const bankControlIds = new Set(
    (controls.data ?? []).filter(c => c.nature === 'bank' || c.nature === 'cash').map(c => c.id)
  );
  const banks = (ledgers.data ?? []).filter(l => bankControlIds.has(l.control_account_id));

  const autoAllocate = async () => {
    if (!partyId || amount <= 0) {
      setNotice('pick a party and enter an amount first');
      return;
    }
    try {
      const out = await api.post<{ allocations: Alloc[]; onAccount: number }>(
        '/payments/suggest', { partyId, kind, amount: amount + discount + deducted });
      setAllocs(out.allocations);
      setNotice(
        out.allocations.length === 0
          ? 'nothing outstanding to settle — this will sit on account'
          : `oldest first: ${out.allocations.length} bill(s) settled, ${money(out.onAccount)} on account`
      );
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : String(e));
    }
  };

  const setAlloc = (invoiceId: string, label: string, value: number) =>
    setAllocs(prev => {
      const rest = prev.filter(a => a.invoiceId !== invoiceId);
      return value > 0 ? [...rest, { invoiceId, label, amount: value }] : rest;
    });

  const addDeduction = () => {
    const bill = partyBills.find(item => item.invoice_id === deductionInvoice);
    if (!bill || deductionAmount <= 0 || deductionReason.trim().length < 2) {
      setNotice('choose a bill, amount and a clear deduction reason');
      return;
    }
    setDeductions(current => [...current, {
      invoiceId: bill.invoice_id, label: bill.invoice_no ?? bill.our_ref ?? '',
      kind: deductionKind, amount: deductionAmount, reason: deductionReason.trim(), taxTreatment
    }]);
    setDeductionAmount(0); setDeductionReason(''); setTaxTreatment('none');
  };

  const save = async () => {
    if (!partyId || amount <= 0) {
      setNotice('pick a party and enter an amount');
      return;
    }
    const out = await submit({
      kind, partyId, paymentDate, mode, amount, discount,
      instrumentNo: instrumentNo || null,
      bankLedgerId: mode === 'cash' ? null : (bankLedgerId || null),
      narration,
      allocations: allocs.map(a => ({
        [kind === 'receipt' ? 'salesInvoiceId' : 'purchaseInvoiceId']: a.invoiceId,
        amount: a.amount
      })),
      deductions: deductions.map(deduction => ({
        [kind === 'receipt' ? 'salesInvoiceId' : 'purchaseInvoiceId']: deduction.invoiceId,
        kind: deduction.kind, amount: deduction.amount, reason: deduction.reason,
        taxTreatment: deduction.taxTreatment
      }))
    });
    if (out) {
      setNotice(
        `${out.voucherNo}: ${money(out.amount)} ${kind === 'receipt' ? 'received' : 'paid'}` +
        (out.allocated > 0 ? `, ${money(out.allocated)} allocated` : '') +
        (out.onAccount > 0 ? `, ${money(out.onAccount)} on account` : '')
      );
      setAmount(0); setDiscount(0); setInstrumentNo(''); setAllocs([]); setDeductions([]);
      payments.reload();
      outstanding.reload();
    }
  };

  const cancel = async (id: string, voucherNo: string) => {
    const reason = prompt(`Why is ${voucherNo} being cancelled?`);
    if (!reason) return;
    try {
      await api.post(`/payments/${id}/cancel`, { reason });
      setNotice(`${voucherNo} cancelled and reversed`);
      payments.reload();
      outstanding.reload();
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon
        title={kind === 'receipt' ? 'Receipt (money in)' : 'Payment (money out)'}
        onSave={save}
        onNew={() => { setAmount(0); setDiscount(0); setAllocs([]); setDeductions([]); setNotice(null); }}
        onExport={() => void payments.exportCsv()}
        onPrint={() => window.print()}
      />

      {(notice || error) && (
        <div className={`px-4 py-1.5 flex items-center gap-2 font-semibold ${
          error ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'
        }`}>
          {error ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
          <span>{error ?? notice}</span>
        </div>
      )}

      <div className="flex-1 overflow-auto p-3 space-y-3">
        <div className="bg-white rounded border border-[#b8c9dd] p-3 grid grid-cols-1 md:grid-cols-12 gap-2.5">
          <div className="md:col-span-2">
            <label htmlFor="payment-type" className="erp-label block text-red-700 font-bold">* Type</label>
            <select id="payment-type" value={kind}
                    onChange={e => { setKind(e.target.value as 'receipt' | 'payment'); setAllocs([]); setDeductions([]); }}
                    className="erp-input w-full">
              <option value="receipt">Receipt — from a customer</option>
              <option value="payment">Payment — to a supplier</option>
            </select>
          </div>
          <div className="md:col-span-3">
            <label htmlFor="payment-party" className="erp-label block text-red-700 font-bold">* Party</label>
            <select id="payment-party" value={partyId}
                    onChange={e => { setPartyId(e.target.value); setAllocs([]); setDeductions([]); }}
                    className="erp-input w-full">
              <option value="">— select —</option>
              {parties.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div className="md:col-span-2">
            <label htmlFor="payment-date" className="erp-label block">Date</label>
            <input id="payment-date" type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)}
                   className="erp-input w-full" />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="payment-mode" className="erp-label block text-red-700 font-bold">* Mode</label>
            <select id="payment-mode" value={mode} onChange={e => setMode(e.target.value as typeof mode)}
                    className="erp-input w-full">
              <option value="neft">NEFT</option>
              <option value="rtgs">RTGS</option>
              <option value="cheque">Cheque</option>
              <option value="upi">UPI</option>
              <option value="cash">Cash</option>
            </select>
          </div>
          <div className="md:col-span-3">
            <label htmlFor="payment-bank" className="erp-label block">
              {mode === 'cash' ? 'Cash account' : 'Bank account'}
            </label>
            <select id="payment-bank" value={bankLedgerId} onChange={e => setBankLedgerId(e.target.value)}
                    className="erp-input w-full" disabled={mode === 'cash'}>
              <option value="">— default —</option>
              {banks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>

          <div className="md:col-span-2">
            <label htmlFor="payment-amount" className="erp-label block text-red-700 font-bold">* Amount</label>
            <input id="payment-amount" type="number" step="0.01" value={amount}
                   onChange={e => setAmount(Number(e.target.value))}
                   className="erp-input w-full text-right font-mono font-bold" />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="payment-discount" className="erp-label block">Discount</label>
            <input id="payment-discount" type="number" step="0.01" value={discount}
                   onChange={e => setDiscount(Number(e.target.value))}
                   className="erp-input w-full text-right font-mono" />
          </div>
          <div className="md:col-span-3">
            <label htmlFor="payment-reference" className="erp-label block">
              {mode === 'cheque' ? 'Cheque no.' : 'Reference / UTR'}
            </label>
            <input id="payment-reference" value={instrumentNo} onChange={e => setInstrumentNo(e.target.value)}
                   className="erp-input w-full font-mono" disabled={mode === 'cash'} />
          </div>
          <div className="md:col-span-5">
            <label htmlFor="payment-narration" className="erp-label block">Narration</label>
            <input id="payment-narration" value={narration} onChange={e => setNarration(e.target.value)}
                   className="erp-input w-full" />
          </div>
        </div>

        {partyId && partyBills.length > 0 && (
          <div className="bg-white rounded border border-[#b8c9dd] p-3 space-y-2">
            <header className="font-bold text-blue-900">Kapat / settlement deductions — each reason posts separately</header>
            <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
              <select aria-label="Deduction bill" value={deductionInvoice}
                      onChange={e => setDeductionInvoice(e.target.value)} className="erp-input md:col-span-2">
                <option value="">— bill —</option>
                {partyBills.map(bill => <option key={bill.invoice_id} value={bill.invoice_id}>
                  {bill.invoice_no ?? bill.our_ref}
                </option>)}
              </select>
              <select aria-label="Deduction type" value={deductionKind}
                      onChange={e => setDeductionKind(e.target.value as Deduction['kind'])}
                      className="erp-input md:col-span-2">
                <option value="cash_discount">Cash discount</option>
                <option value="quality_discount">Quality / shade</option>
                <option value="rate_difference">Rate difference</option>
                <option value="shortage">Shortage claim</option>
                <option value="tds">TDS</option>
                <option value="other">Other</option>
              </select>
              <input aria-label="Deduction amount" type="number" step="0.01" value={deductionAmount || ''}
                     onChange={e => setDeductionAmount(Number(e.target.value))}
                     placeholder="Amount" className="erp-input md:col-span-2 text-right font-mono" />
              <input aria-label="Deduction reason" value={deductionReason}
                     onChange={e => setDeductionReason(e.target.value)}
                     placeholder="Reason / claim reference" className="erp-input md:col-span-3" />
              <select aria-label="GST note treatment" value={taxTreatment}
                      onChange={e => setTaxTreatment(e.target.value as Deduction['taxTreatment'])}
                      className="erp-input md:col-span-2">
                <option value="none">No GST note</option>
                <option value="credit_note_required">Credit note required</option>
                <option value="debit_note_required">Debit note required</option>
              </select>
              <button type="button" onClick={addDeduction} className="erp-btn md:col-span-1 justify-center">
                <Plus className="w-3.5 h-3.5" /> Add
              </button>
            </div>
            {deductions.map((deduction, index) => (
              <div key={`${deduction.invoiceId}-${index}`} className="flex items-center gap-3 bg-slate-50 border px-2 py-1">
                <span className="font-mono font-bold">{deduction.label}</span>
                <span>{deduction.kind.replaceAll('_', ' ')}</span>
                <span className="font-mono">{money(deduction.amount)}</span>
                <span className="flex-1">{deduction.reason}</span>
                {deduction.taxTreatment !== 'none' && <span className="text-amber-800 font-bold">GST note pending</span>}
                <button type="button" onClick={() => setDeductions(current => current.filter((_, i) => i !== index))}
                        title="Remove deduction" className="text-red-700"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        )}

        {partyId && (
          <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
            <header className="px-3 py-2 border-b border-slate-200 flex items-center gap-2">
              <Wallet className="w-4 h-4 text-blue-700" />
              <span className="font-bold text-blue-900">
                Outstanding bills — {money(totalDue)} due
              </span>
              <button onClick={autoAllocate} className="erp-btn ml-auto">
                <Wand2 className="w-3.5 h-3.5 text-blue-600" />
                <span>Settle oldest first</span>
              </button>
            </header>
            <table className="w-full">
              <thead className="bg-slate-100 border-b border-slate-300 text-left">
                <tr>
                  <th className="px-2 py-1.5 font-bold">Bill</th>
                  <th className="px-2 py-1.5 font-bold">Date</th>
                  <th className="px-2 py-1.5 font-bold text-right">Total</th>
                  <th className="px-2 py-1.5 font-bold text-right">Already paid</th>
                  <th className="px-2 py-1.5 font-bold text-right">Outstanding</th>
                  <th className="px-2 py-1.5 font-bold text-right">Overdue</th>
                  <th className="px-2 py-1.5 font-bold text-right">Settle now</th>
                </tr>
              </thead>
              <tbody>
                {partyBills.length === 0 && (
                  <tr><td colSpan={7} className="px-2 py-4 text-center text-slate-400">
                    Nothing outstanding — this will be recorded on account
                  </td></tr>
                )}
                {partyBills.map(o => {
                  const label = o.invoice_no ?? o.our_ref ?? '';
                  const current = allocs.find(a => a.invoiceId === o.invoice_id)?.amount ?? 0;
                  return (
                    <tr key={o.invoice_id} className="border-b border-slate-100">
                      <td className="px-2 py-1 font-mono text-blue-800">{label}</td>
                      <td className="px-2 py-1">{o.invoice_date}</td>
                      <td className="px-2 py-1 text-right font-mono">{money(o.invoice_total)}</td>
                      <td className="px-2 py-1 text-right font-mono">{money(o.paid)}</td>
                      <td className="px-2 py-1 text-right font-mono font-bold">{money(o.outstanding)}</td>
                      <td className={`px-2 py-1 text-right font-mono ${
                        Number(o.overdue_days ?? 0) > 0 ? 'text-red-700 font-bold' : ''
                      }`}>
                        {o.overdue_days ?? 0}d
                      </td>
                      <td className="px-2 py-1 text-right">
                        <input type="number" step="0.01" value={current || ''}
                               max={Number(o.outstanding)}
                               onChange={e => setAlloc(o.invoice_id, label, Number(e.target.value))}
                               className="erp-input w-28 text-right font-mono" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="bg-slate-50 border-t border-slate-300 px-3 py-2 flex items-center justify-end gap-6 font-bold">
              <span>Allocated: {money(allocated)}</span>
              <span>Kapat: {money(deducted + discount)}</span>
              <span className={onAccount < 0 ? 'text-red-700' : ''}>
                On account: {money(onAccount)}
              </span>
              <button onClick={save} disabled={busy}
                      className="erp-btn erp-btn-primary font-bold disabled:opacity-60">
                {busy ? 'Posting…' : kind === 'receipt' ? 'Record Receipt' : 'Record Payment'}
              </button>
            </div>
          </div>
        )}

        <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
          <header className="px-3 py-2 border-b border-slate-200 font-bold text-blue-900">
            Cash book
          </header>
          <ListControls list={payments} placeholder="Voucher, party or instrument…" />
          <table className="w-full">
            <thead className="bg-slate-100 border-b border-slate-300 text-left">
              <tr>
                <th className="px-2 py-1.5 font-bold">Voucher</th>
                <th className="px-2 py-1.5 font-bold">Date</th>
                <th className="px-2 py-1.5 font-bold">Party</th>
                <th className="px-2 py-1.5 font-bold">Mode</th>
                <th className="px-2 py-1.5 font-bold">Reference</th>
                <th className="px-2 py-1.5 font-bold text-right">In</th>
                <th className="px-2 py-1.5 font-bold text-right">Out</th>
                <th className="px-2 py-1.5 font-bold text-right">Allocated</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {payments.rows.map(p => (
                <tr key={p.id} className={`border-b border-slate-100 ${
                  p.status === 'cancelled' ? 'line-through text-slate-400' : ''
                }`}>
                  <td className="px-2 py-1 font-mono text-blue-800">{p.voucher_no}</td>
                  <td className="px-2 py-1">{p.payment_date}</td>
                  <td className="px-2 py-1">{p.party_name}</td>
                  <td className="px-2 py-1 uppercase">{p.mode}</td>
                  <td className="px-2 py-1 font-mono">{p.instrument_no ?? ''}</td>
                  <td className="px-2 py-1 text-right font-mono text-emerald-800">
                    {p.kind === 'receipt' ? money(p.amount) : ''}
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-red-800">
                    {p.kind === 'payment' ? money(p.amount) : ''}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">{money(p.allocated)}</td>
                  <td className="px-2 py-1 text-right">
                    {p.status !== 'cancelled' && (
                      <button onClick={() => cancel(p.id, p.voucher_no)}
                              title="Cancel and reverse" className="text-red-600 hover:text-red-800">
                        <XCircle className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!payments.loading && payments.rows.length === 0 && (
                <tr><td colSpan={9} className="px-2 py-5 text-center text-slate-400">
                  Nothing received or paid yet
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
