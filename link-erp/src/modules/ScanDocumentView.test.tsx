import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ScanDocumentView } from './ScanDocumentView';

const CUSTOMER = '00000000-0000-0000-0000-000000000601';
const CONTROL = '00000000-0000-0000-0000-000000000602';
const ORDER_LINE = '00000000-0000-0000-0000-000000000603';
const sent: { path: string; body: any }[] = [];

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const pathWithQuery = String(url).replace(/^.*\/api/, '');
    const path = pathWithQuery.split('?')[0]!;
    if (init?.method === 'POST') {
      sent.push({ path, body: JSON.parse(String(init.body ?? '{}')) });
      return { ok: true, status: 201, headers: new Headers(), text: async () => JSON.stringify({
        id: 'dispatch', challanNo: 'DC/26-27/80', pieces: 1, value: 8075
      }) } as Response;
    }
    const bodies: Record<string, unknown> = {
      '/ledgers': [{ id: CUSTOMER, name: 'Supreme Garments', control_account_id: CONTROL, code: '701' }],
      '/control-accounts': [{ id: CONTROL, nature: 'sundry_debtor_finish' }],
      '/pieces': [{ id: 'piece', barcode: 'SO0001', status: 'received_finish', lot_no: 'LOT-SO',
        grade_code: 'A', uom: 'MTR', rack_code: null, grey_qty: 100, finish_qty: 95,
        current_qty: 95, cost: 4700, quality: 'Galaxy', design: null, held_by: null }],
      '/sales-invoices': { rows: [], total: 0, limit: 50, offset: 0 },
      '/sales-orders': { rows: [{ id: 'order', order_no: 'SO/26-27/8', party_id: CUSTOMER,
        status: 'approved', lines: [{ id: ORDER_LINE, sno: 1, quality: 'Galaxy', grade_code: 'A',
          qty: 500, dispatched_qty: 100, rate: 85 }] }], total: 1, limit: 100000, offset: 0 }
    };
    return { ok: true, status: 200, headers: new Headers(),
      text: async () => JSON.stringify(bodies[path] ?? []) } as Response;
  }));
});

describe('ScanDocumentView dispatch allocation', () => {
  test('auto-allocates a matching open sales-order line and posts its locked rate', async () => {
    render(<ScanDocumentView kind="dispatch" />);
    await screen.findByRole('option', { name: 'Supreme Garments' });
    fireEvent.change(screen.getByLabelText(/Customer/), { target: { value: CUSTOMER } });
    fireEvent.change(screen.getByLabelText(/Challan No/), { target: { value: 'DC-CLIENT-80' } });
    fireEvent.change(screen.getByLabelText('Scan barcode'), { target: { value: 'SO0001' } });
    fireEvent.submit(screen.getByLabelText('Scan barcode').closest('form')!);

    const allocation = await screen.findByLabelText('Sales order for SO0001');
    expect(allocation).toHaveValue(ORDER_LINE);
    expect(screen.getByText('85.00')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Post Challan' }));

    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toEqual(expect.objectContaining({ path: '/dispatches' }));
    expect(sent[0]!.body.lines).toEqual([{ barcode: 'SO0001', rate: 85, soLineId: ORDER_LINE }]);
  });
});
