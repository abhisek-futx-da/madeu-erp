import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PurchaseOrderView } from './PurchaseOrderView';

const SUPPLIER = '00000000-0000-0000-0000-000000000101';
const QUALITY = '00000000-0000-0000-0000-000000000201';
const PO = '00000000-0000-0000-0000-000000000301';
const sent: any[] = [];

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const pathWithQuery = String(url).replace(/^.*\/api/, '');
    const path = pathWithQuery.split('?')[0]!;
    if (init?.method === 'POST') {
      sent.push({ path, body: JSON.parse(String(init.body ?? '{}')) });
      return { ok: true, status: 201, headers: new Headers(), text: async () => JSON.stringify({ id: PO, orderNo: 'GPO/26-27/9' }) } as Response;
    }
    const bodies: Record<string, unknown> = {
      '/ledgers': [{ id: SUPPLIER, name: 'L.R. Textiles', control_account_id: 'raw', code: '105' }],
      '/control-accounts': [{ id: 'raw', nature: 'sundry_creditor_grey' }],
      '/qualities': [{ id: QUALITY, name: 'Galaxy', code: 'GAL', construction: '', selvedge_line: '', width_cms: 150, bill_by: 'meters', hsn_code: '551311', division: '', is_active: true }],
      '/grades': [{ code: 'A', name: 'Fresh', sort_order: 1 }],
      '/configuration/rate': { rate: 31.75 },
      '/grey-purchase-orders': { rows: [{ id: PO, order_no: 'GPO/26-27/8', order_date: '2026-08-20', delivery_date: '2026-09-05', party_name: 'L.R. Textiles', party_gstin: '27ABCDE1234F1Z5', broker_name: null, transport_name: null, payment_terms: '30 days', remarks: '', status: 'approved', lines: [{ sno: 1, quality: 'Galaxy', design: null, grade_code: 'A', pcs: 2, qty: 200, rate: 30, amount: 6000, received_qty: 100 }] }], total: 1, limit: 50, offset: 0 },
      [`/grey-purchase-orders/${PO}/print`]: { order_no: 'GPO/26-27/8', order_date: '2026-08-20', delivery_date: '2026-09-05', delivery_days: 15, payment_terms: '30 days', delivery_terms: '', remarks: '', status: 'approved', buyer_name: 'Neelkamal Textiles', buyer_gstin: '27ANBPC3604Q1Z0', buyer_address: 'Mill Road', buyer_address2: null, buyer_city: 'Bhiwandi', buyer_pincode: '421302', supplier_name: 'L.R. Textiles', supplier_gstin: '27ABCDE1234F1Z5', supplier_address: 'Market Road', supplier_city: 'Bhiwandi', supplier_pincode: '421302', supplier_state: '27', broker_name: null, transport_name: null, total: 6000, amount_in_words: 'Rupees Six Thousand Only', lines: [{ sno: 1, quality: 'Galaxy', construction: '', hsn_code: '551311', design: null, grade_code: 'A', pcs: 2, cut_length: 100, qty: 200, rate: 30, amount: 6000, received_qty: 100 }] }
    };
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(bodies[path] ?? []) } as Response;
  }));
});

describe('PurchaseOrderView', () => {
  test('books computed quantity and price against a real grey supplier', async () => {
    render(<PurchaseOrderView />);
    await screen.findByRole('option', { name: 'L.R. Textiles' });
    fireEvent.change(screen.getByLabelText('Grey supplier'), { target: { value: SUPPLIER } });
    fireEvent.click(screen.getByRole('button', { name: /add line/i }));
    fireEvent.change(screen.getByLabelText('Pieces for purchase order line 1'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Cut length for purchase order line 1'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('Rate for purchase order line 1'), { target: { value: '32.5' } });
    fireEvent.click(screen.getByRole('button', { name: /book purchase order/i }));

    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0].path).toBe('/grey-purchase-orders');
    expect(sent[0].body.lines[0]).toEqual(expect.objectContaining({ pcs: 3, cutLength: 90, qty: 270, rate: 32.5 }));
    expect(await screen.findByText(/GPO\/26-27\/9 booked/i)).toBeInTheDocument();
  });

  test('shows pending receipt balance and opens a printable supplier document', async () => {
    render(<PurchaseOrderView />);
    expect((await screen.findAllByText('100.00')).length).toBe(2);
    fireEvent.click(screen.getByTitle('Print purchase order GPO/26-27/8'));
    expect(await screen.findByRole('heading', { name: 'PURCHASE ORDER' })).toBeInTheDocument();
    expect(screen.getAllByText('Neelkamal Textiles').length).toBeGreaterThan(0);
    expect(screen.getByText('Rupees Six Thousand Only')).toBeInTheDocument();
  });

  test('applies the valid purchase rate from the company master', async () => {
    render(<PurchaseOrderView />);
    await screen.findByRole('option', { name: 'L.R. Textiles' });
    fireEvent.change(screen.getByLabelText('Grey supplier'), { target: { value: SUPPLIER } });
    fireEvent.click(screen.getByRole('button', { name: /add line/i }));
    fireEvent.click(screen.getByTitle('Apply valid purchase rate contract'));
    await waitFor(() => expect(screen.getByLabelText('Rate for purchase order line 1')).toHaveValue(31.75));
  });
});
