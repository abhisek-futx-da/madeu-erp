import React from 'react';
import { useApi } from '../lib/useApi';
import type { Session } from '../lib/api';
import { Printer, X } from 'lucide-react';

interface Line {
  sno: number; description: string; hsn_code: string; qty: number; uom: string;
  rate: number; taxable_value: number; gst_rate: number;
  cgst_amount: number; sgst_amount: number; igst_amount: number; line_total: number;
}

interface Invoice {
  invoice_no: string; invoice_date: string; place_of_supply: string; supply_type: string;
  taxable_value: number; cgst_amount: number; sgst_amount: number; igst_amount: number;
  round_off: number; invoice_total: number;
  party_name: string; gstin: string | null; irn: string | null;
  party_address: string | null; party_city: string | null;
  party_pincode: string | null; party_state: string | null;
  lines: Line[];
}

const inr = (v: number) =>
  `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Rupees in words, as every Indian tax invoice carries. */
function words(amount: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
    'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const under100 = (n: number): string =>
    n < 20 ? ones[n]! : `${tens[Math.floor(n / 10)]}${n % 10 ? ' ' + ones[n % 10] : ''}`;
  const under1000 = (n: number): string =>
    n < 100 ? under100(n)
      : `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' + under100(n % 100) : ''}`;

  let n = Math.floor(Math.abs(amount));
  if (n === 0) return 'Zero Rupees Only';

  // Indian grouping: crore, lakh, thousand, hundred.
  const parts: string[] = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000);    n %= 100000;
  const thousand = Math.floor(n / 1000);  n %= 1000;

  if (crore) parts.push(`${under1000(crore)} Crore`);
  if (lakh) parts.push(`${under100(lakh)} Lakh`);
  if (thousand) parts.push(`${under100(thousand)} Thousand`);
  if (n) parts.push(under1000(n));

  const paise = Math.round((Math.abs(amount) - Math.floor(Math.abs(amount))) * 100);
  return `${parts.join(' ')} Rupees${paise ? ` and ${under100(paise)} Paise` : ''} Only`;
}

interface Props {
  invoiceId: string;
  session: Session;
  onClose: () => void;
}

export const InvoicePrintView: React.FC<Props> = ({ invoiceId, session, onClose }) => {
  const { data, error, loading } = useApi<Invoice>(`/sales-invoices/${invoiceId}/print`);

  if (loading) return <Overlay onClose={onClose}><p className="p-8">Loading…</p></Overlay>;
  if (error || !data) {
    return <Overlay onClose={onClose}><p className="p-8 text-red-700">{error ?? 'not found'}</p></Overlay>;
  }

  const intra = data.supply_type === 'intra_state';
  const t = session.tenant;

  return (
    <Overlay onClose={onClose}>
      <div className="print-area bg-white text-black p-6 text-[11px]" style={{ minWidth: 720 }}>
        <div className="text-center border-b-2 border-black pb-2 mb-2">
          <h1 className="text-lg font-bold uppercase tracking-wide">{t?.legalName}</h1>
          <p>GSTIN: {t?.gstin}</p>
          <p className="font-bold mt-1">TAX INVOICE</p>
        </div>

        <table className="w-full mb-2" style={{ border: '1px solid #000' }}>
          <tbody>
            <tr>
              <td className="align-top w-1/2">
                <strong>Billed to</strong><br />
                {data.party_name}<br />
                {data.party_address}<br />
                {data.party_city} {data.party_pincode}<br />
                GSTIN: {data.gstin ?? 'Unregistered'}<br />
                Place of supply: {data.place_of_supply}
              </td>
              <td className="align-top">
                <strong>Invoice No:</strong> {data.invoice_no}<br />
                <strong>Date:</strong> {data.invoice_date}<br />
                <strong>Supply:</strong> {intra ? 'Intra-state' : 'Inter-state'}<br />
                {data.irn && <><strong>IRN:</strong> <span className="break-all">{data.irn}</span></>}
              </td>
            </tr>
          </tbody>
        </table>

        <table className="w-full" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th>#</th><th className="text-left">Description</th><th>HSN</th>
              <th className="text-right">Qty</th><th>UQC</th>
              <th className="text-right">Rate</th><th className="text-right">Taxable</th>
              {intra ? <><th className="text-right">CGST</th><th className="text-right">SGST</th></>
                     : <th className="text-right">IGST</th>}
              <th className="text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map(l => (
              <tr key={l.sno}>
                <td className="text-center">{l.sno}</td>
                <td>{l.description}</td>
                <td className="text-center">{l.hsn_code}</td>
                <td className="text-right">{Number(l.qty).toFixed(2)}</td>
                <td className="text-center">{l.uom}</td>
                <td className="text-right">{Number(l.rate).toFixed(2)}</td>
                <td className="text-right">{Number(l.taxable_value).toFixed(2)}</td>
                {intra ? (
                  <>
                    <td className="text-right">{Number(l.cgst_amount).toFixed(2)}</td>
                    <td className="text-right">{Number(l.sgst_amount).toFixed(2)}</td>
                  </>
                ) : (
                  <td className="text-right">{Number(l.igst_amount).toFixed(2)}</td>
                )}
                <td className="text-right">{Number(l.line_total).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-bold">
              <td colSpan={6} className="text-right">Taxable Value</td>
              <td className="text-right">{Number(data.taxable_value).toFixed(2)}</td>
              <td colSpan={intra ? 3 : 2}></td>
            </tr>
            {intra ? (
              <>
                <tr><td colSpan={6} className="text-right">CGST</td>
                    <td colSpan={4} className="text-right">{Number(data.cgst_amount).toFixed(2)}</td></tr>
                <tr><td colSpan={6} className="text-right">SGST</td>
                    <td colSpan={4} className="text-right">{Number(data.sgst_amount).toFixed(2)}</td></tr>
              </>
            ) : (
              <tr><td colSpan={6} className="text-right">IGST</td>
                  <td colSpan={4} className="text-right">{Number(data.igst_amount).toFixed(2)}</td></tr>
            )}
            <tr><td colSpan={6} className="text-right">Rounding</td>
                <td colSpan={4} className="text-right">{Number(data.round_off).toFixed(2)}</td></tr>
            <tr className="font-bold text-[13px]">
              <td colSpan={6} className="text-right">Invoice Total</td>
              <td colSpan={4} className="text-right">{inr(data.invoice_total)}</td>
            </tr>
          </tfoot>
        </table>

        <p className="mt-2"><strong>Amount in words:</strong> {words(data.invoice_total)}</p>

        <div className="flex justify-between mt-8 pt-2">
          <div className="text-[10px]">
            <p className="font-bold">Declaration</p>
            <p>We declare that this invoice shows the actual price of the goods described
              and that all particulars are true and correct.</p>
          </div>
          <div className="text-center">
            <p className="mb-10">For {t?.legalName}</p>
            <p className="border-t border-black pt-1">Authorised Signatory</p>
          </div>
        </div>
      </div>
    </Overlay>
  );
};

const Overlay: React.FC<{ children: React.ReactNode; onClose: () => void }> = ({ children, onClose }) => (
  <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center overflow-auto p-6">
    <div className="bg-white shadow-2xl">
      <div className="no-print flex items-center gap-2 px-3 py-2 bg-blue-800 text-white">
        <span className="font-bold text-xs">Print preview</span>
        <button onClick={() => window.print()} className="erp-btn erp-btn-primary ml-auto font-bold">
          <Printer className="w-3.5 h-3.5" /><span>Print</span>
        </button>
        <button onClick={onClose} className="erp-btn" title="Close"><X className="w-3.5 h-3.5" /></button>
      </div>
      {children}
    </div>
  </div>
);
