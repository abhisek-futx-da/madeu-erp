import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, MessageCircle, RefreshCw, XCircle } from 'lucide-react';
import { api, ApiError, type Page } from '../lib/api';
import { useApi } from '../lib/useApi';

const today = () => new Date().toISOString().slice(0, 10);
const fyStart = () => {
  const date = new Date();
  const year = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return `${year}-04-01`;
};
const money = (value: number) => `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

interface ReceiptBalance {
  receipt_line_id: string; receipt_no: string; entry_date: string; process_house_id: string;
  process_house: string; barcode: string; quality: string; received_qty: number;
  received_weight_kg: number | null; expected_amount: number;
  unbilled_metres: number; unbilled_amount: number;
}
interface BillRow {
  bill_id: string; supplier_bill_no: string; bill_date: string; process_house: string;
  billed_metres: number; billed_amount: number; matched_metres: number; matched_amount: number;
  metre_difference: number; amount_difference: number; status: string;
}
interface InvoiceRow { id: string; invoice_no: string; party_name: string; invoice_total: number; status: string }
interface OutstandingRow {
  party_id: string; party: string; outstanding: number; overdue_days: number;
}
interface NotificationRow {
  id: string; kind: string; recipient_name: string; phone_e164: string; state: string;
  attempts: number; last_error: string | null; provider_id: string | null;
}

export const MillIntegrationView: React.FC = () => {
  const [from, setFrom] = useState(fyStart());
  const [to, setTo] = useState(today());
  const [house, setHouse] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [billNo, setBillNo] = useState('');
  const [billDate, setBillDate] = useState(today());
  const [billAmount, setBillAmount] = useState(0);
  const [invoiceId, setInvoiceId] = useState('');
  const [invoiceRecipient, setInvoiceRecipient] = useState<'customer' | 'broker'>('customer');
  const [phone, setPhone] = useState('');
  const [reminderPartyId, setReminderPartyId] = useState('');
  const [reminderPhone, setReminderPhone] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const balances = useApi<ReceiptBalance[]>('/process-house-bills/available-receipts');
  const bills = useApi<BillRow[]>('/process-house-bills');
  const invoices = useApi<Page<InvoiceRow>>('/sales-invoices?limit=200');
  const outstanding = useApi<OutstandingRow[]>('/reports/outstanding-sales?limit=5000');
  const notifications = useApi<{ providerConfigured: boolean; rows: NotificationRow[] }>('/notifications');

  const houses = useMemo(() => [...new Map((balances.data ?? []).map(row =>
    [row.process_house_id, row.process_house] as const)).entries()], [balances.data]);
  const visible = (balances.data ?? []).filter(row => !house || row.process_house_id === house);
  const selected = visible.filter(row => picked.has(row.receipt_line_id));
  const selectedMetres = selected.reduce((sum, row) => sum + Number(row.unbilled_metres), 0);
  const selectedExpected = selected.reduce((sum, row) => sum + Number(row.unbilled_amount), 0);
  const reminderParties = useMemo(() => {
    const grouped = new Map<string, { id: string; name: string; outstanding: number; overdue: number }>();
    for (const row of outstanding.data ?? []) {
      const current = grouped.get(row.party_id) ?? { id: row.party_id, name: row.party, outstanding: 0, overdue: 0 };
      current.outstanding += Number(row.outstanding);
      if (Number(row.overdue_days) > 0) current.overdue += Number(row.outstanding);
      grouped.set(row.party_id, current);
    }
    return [...grouped.values()].sort((a, b) => b.overdue - a.overdue || a.name.localeCompare(b.name));
  }, [outstanding.data]);

  const toggle = (id: string) => setPicked(current => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const createBill = async () => {
    if (!house || !billNo.trim() || selected.length === 0 || billAmount < 0) {
      setError('choose a process house, bill number, amount and at least one receipt line');
      return;
    }
    setBusy(true); setError(null);
    try {
      let assigned = 0;
      const allocations = selected.map((row, index) => {
        const amount = index === selected.length - 1
          ? Math.round((billAmount - assigned) * 100) / 100
          : Math.round((selectedExpected > 0
            ? billAmount * Number(row.unbilled_amount) / selectedExpected
            : 0) * 100) / 100;
        assigned += amount;
        return { receiptLineId: row.receipt_line_id,
          allocatedMetres: Number(row.unbilled_metres), allocatedAmount: amount };
      });
      const result = await api.post<BillRow>('/process-house-bills', {
        processHouseId: house, supplierBillNo: billNo.trim(), billDate,
        billedMetres: selectedMetres, billedAmount: billAmount, allocations
      });
      setNotice(`${result.supplier_bill_no} reconciled to ${Number(result.matched_metres).toFixed(2)} metres`);
      setBillNo(''); setBillAmount(0); setPicked(new Set());
      balances.reload(); bills.reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const queueInvoice = async () => {
    if (!invoiceId) { setError('choose an approved invoice'); return; }
    setBusy(true); setError(null);
    try {
      const result = await api.post<{ id: string; state: string }> (`/notifications/invoices/${invoiceId}`,
        { ...(phone ? { phoneE164: phone } : {}), recipient: invoiceRecipient });
      setNotice(`Invoice message queued as ${result.state}`); setPhone(''); notifications.reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const queueReminder = async () => {
    if (!reminderPartyId) { setError('choose a customer with an outstanding bill'); return; }
    setBusy(true); setError(null);
    try {
      const result = await api.post<{ id: string; state: string }>(`/notifications/reminders/${reminderPartyId}`,
        { asOf: today(), ...(reminderPhone ? { phoneE164: reminderPhone } : {}) });
      setNotice(`Payment reminder queued as ${result.state}`);
      setReminderPhone(''); notifications.reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const sendNotification = async (id: string) => {
    setBusy(true); setError(null);
    try {
      await api.post(`/notifications/${id}/send`, {});
      setNotice('WhatsApp provider accepted the message'); notifications.reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); notifications.reload(); }
    finally { setBusy(false); }
  };

  const cancelBill = async (bill: BillRow) => {
    const reason = window.prompt(`Reason for cancelling ${bill.supplier_bill_no}?`);
    if (!reason?.trim()) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/process-house-bills/${bill.bill_id}/cancel`, { reason: reason.trim() });
      setNotice(`${bill.supplier_bill_no} cancelled; its receipt allocations are available again`);
      balances.reload(); bills.reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const cancelNotification = async (id: string) => {
    setBusy(true); setError(null);
    try {
      await api.post(`/notifications/${id}/cancel`, {});
      setNotice('Queued message cancelled'); notifications.reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return <div className="h-full overflow-auto bg-[#ecf1f7] p-3 text-xs space-y-3">
    <h1 className="text-base font-bold text-blue-950">Mill interoperability and settlement desk</h1>
    {(notice || error) && <div role="status" className={`px-3 py-2 flex gap-2 font-semibold ${
      error ? 'bg-red-700 text-white' : 'bg-emerald-700 text-white'}`}>
      {error ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
      {error ?? notice}
    </div>}

    <section className="bg-white border border-[#b8c9dd] rounded p-3 space-y-2">
      <h2 className="font-bold text-blue-900">Tally voucher export</h2>
      <p className="text-slate-600">Exports posted, balanced vouchers only. Import first into a copy of the CA's Tally company.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label>From<input type="date" value={from} onChange={e => setFrom(e.target.value)} className="erp-input block" /></label>
        <label>To<input type="date" value={to} onChange={e => setTo(e.target.value)} className="erp-input block" /></label>
        <button onClick={() => void api.download(`/exports/tally.xml?from=${from}&to=${to}`, 'tally-vouchers.xml')}
                className="erp-btn erp-btn-primary font-bold"><Download className="w-4 h-4" />Download Tally XML</button>
      </div>
    </section>

    <section className="bg-white border border-[#b8c9dd] rounded overflow-hidden">
      <header className="p-3 border-b font-bold text-blue-900">Consolidated process-house bill reconciliation</header>
      <div className="p-3 grid grid-cols-1 md:grid-cols-12 gap-2">
        <select aria-label="Process house" value={house} onChange={e => { setHouse(e.target.value); setPicked(new Set()); }}
                className="erp-input md:col-span-3"><option value="">— process house —</option>
          {houses.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <input aria-label="Supplier bill number" value={billNo} onChange={e => setBillNo(e.target.value)}
               placeholder="Supplier bill no." className="erp-input md:col-span-2" />
        <input aria-label="Bill date" type="date" value={billDate} onChange={e => setBillDate(e.target.value)}
               className="erp-input md:col-span-2" />
        <input aria-label="Billed amount" type="number" step="0.01" value={billAmount || ''}
               onChange={e => setBillAmount(Number(e.target.value))} placeholder="Bill amount"
               className="erp-input md:col-span-2 text-right font-mono" />
        <button type="button" onClick={() => setBillAmount(Math.round(selectedExpected * 100) / 100)}
                className="erp-btn md:col-span-1">Use expected</button>
        <button onClick={createBill} disabled={busy} className="erp-btn erp-btn-primary md:col-span-2 font-bold">Save reconciliation</button>
      </div>
      <div className="overflow-auto max-h-72">
        <table className="w-full"><thead className="bg-slate-100 sticky top-0"><tr>
          <th className="p-2"></th><th className="p-2 text-left">Receipt</th><th className="p-2 text-left">Barcode</th>
          <th className="p-2 text-left">Quality</th><th className="p-2 text-right">Unbilled mtr</th>
          <th className="p-2 text-right">Weight kg</th><th className="p-2 text-right">Expected</th>
        </tr></thead><tbody>
          {visible.map(row => <tr key={row.receipt_line_id} className="border-t">
            <td className="p-2"><input type="checkbox" checked={picked.has(row.receipt_line_id)} onChange={() => toggle(row.receipt_line_id)} /></td>
            <td className="p-2 font-mono">{row.receipt_no}<div className="text-slate-500">{row.entry_date}</div></td>
            <td className="p-2 font-mono text-blue-800">{row.barcode}</td><td className="p-2">{row.quality}</td>
            <td className="p-2 text-right font-mono">{Number(row.unbilled_metres).toFixed(2)}</td>
            <td className="p-2 text-right font-mono">{row.received_weight_kg == null ? '—' : Number(row.received_weight_kg).toFixed(3)}</td>
            <td className="p-2 text-right font-mono">{money(row.unbilled_amount)}</td>
          </tr>)}
          {!balances.loading && visible.length === 0 && <tr><td colSpan={7} className="p-5 text-center text-slate-400">No unbilled receipt lines</td></tr>}
        </tbody></table>
      </div>
      <footer className="p-2 bg-slate-50 border-t flex justify-end gap-5 font-bold">
        <span>{selected.length} lines</span><span>{selectedMetres.toFixed(2)} MTR</span><span>{money(selectedExpected)} expected</span>
      </footer>
      {bills.data && bills.data.length > 0 && <div className="p-3 border-t">
        <h3 className="font-bold mb-1">Recent bills</h3>
        {bills.data.slice(0, 8).map(bill => <div key={bill.bill_id} className="grid grid-cols-6 gap-2 border-t py-1 items-center">
          <span className="font-mono">{bill.supplier_bill_no}</span><span>{bill.process_house}</span>
          <span className="text-right">{Number(bill.matched_metres).toFixed(2)} MTR</span>
          <span className="text-right">{money(bill.matched_amount)}</span>
          <span className={`text-right font-bold ${Math.abs(Number(bill.amount_difference)) > .005 ? 'text-amber-800' : 'text-emerald-800'}`}>
            {bill.status === 'cancelled' ? 'Cancelled' : `Difference ${money(bill.amount_difference)}`}</span>
          <span className="text-right">{bill.status !== 'cancelled' && <button type="button" disabled={busy}
            onClick={() => void cancelBill(bill)} className="erp-btn text-red-700" title="Cancel bill reconciliation">
            <XCircle className="w-3.5 h-3.5" />Cancel</button>}</span>
        </div>)}
      </div>}
    </section>

    <section className="bg-white border border-[#b8c9dd] rounded p-3 space-y-2">
      <div className="flex items-center gap-2"><MessageCircle className="w-4 h-4 text-green-700" />
        <h2 className="font-bold text-blue-900">WhatsApp invoice outbox</h2>
        <span className={`ml-auto font-bold ${notifications.data?.providerConfigured ? 'text-emerald-700' : 'text-amber-800'}`}>
          {notifications.data?.providerConfigured ? 'Provider configured' : 'Credentials not configured'}</span></div>
      <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
        <select aria-label="Invoice to message" value={invoiceId} onChange={e => setInvoiceId(e.target.value)}
                className="erp-input md:col-span-4"><option value="">— approved invoice —</option>
          {(invoices.data?.rows ?? []).filter(invoice => invoice.status === 'approved').map(invoice =>
            <option key={invoice.id} value={invoice.id}>{invoice.invoice_no} · {invoice.party_name} · {money(invoice.invoice_total)}</option>)}
        </select>
        <select aria-label="Invoice recipient" value={invoiceRecipient}
                onChange={e => setInvoiceRecipient(e.target.value as 'customer' | 'broker')}
                className="erp-input md:col-span-2"><option value="customer">Customer</option><option value="broker">Broker</option></select>
        <input aria-label="WhatsApp override number" value={phone} onChange={e => setPhone(e.target.value)}
               placeholder="optional +91… override" className="erp-input md:col-span-2 font-mono" />
        <button onClick={queueInvoice} disabled={busy} className="erp-btn erp-btn-primary md:col-span-2 font-bold">Queue invoice</button>
        <button onClick={() => notifications.reload()} className="erp-btn md:col-span-2"><RefreshCw className="w-3.5 h-3.5" />Refresh</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-12 gap-2 border-t pt-2">
        <select aria-label="Customer for payment reminder" value={reminderPartyId}
                onChange={e => setReminderPartyId(e.target.value)} className="erp-input md:col-span-5">
          <option value="">— customer with outstanding bill —</option>
          {reminderParties.map(party => <option key={party.id} value={party.id}>{party.name} · {money(party.outstanding)} due · {money(party.overdue)} overdue</option>)}
        </select>
        <input aria-label="Reminder WhatsApp override number" value={reminderPhone}
               onChange={e => setReminderPhone(e.target.value)} placeholder="optional +91… override"
               className="erp-input md:col-span-3 font-mono" />
        <button onClick={queueReminder} disabled={busy} className="erp-btn erp-btn-primary md:col-span-2 font-bold">Queue reminder</button>
        <button onClick={() => reminderPartyId && void api.download(
          `/ledgers/${reminderPartyId}/outstanding-statement.pdf?asOf=${today()}`, 'outstanding-statement.pdf')}
          disabled={!reminderPartyId} className="erp-btn md:col-span-2 disabled:opacity-50">
          <Download className="w-3.5 h-3.5" />Statement PDF</button>
      </div>
      {(notifications.data?.rows ?? []).slice(0, 10).map(row => <div key={row.id} className="flex items-center gap-3 border-t py-1">
        <span className="uppercase text-[10px] font-bold text-slate-500">{row.kind.replace('_', ' ')}</span>
        <span className="font-bold">{row.recipient_name}</span><span className="font-mono">{row.phone_e164}</span>
        <span className="uppercase font-bold">{row.state}</span><span className="text-red-700 flex-1 truncate">{row.last_error ?? ''}</span>
        {(row.state === 'pending' || row.state === 'failed') && <><button onClick={() => void sendNotification(row.id)}
          disabled={busy || !notifications.data?.providerConfigured} className="erp-btn">Send now</button>
          <button onClick={() => void cancelNotification(row.id)} disabled={busy} className="erp-btn text-red-700">Cancel</button></>}
      </div>)}
    </section>
  </div>;
};
