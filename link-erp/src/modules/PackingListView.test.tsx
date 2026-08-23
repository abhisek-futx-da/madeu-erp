import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PackingListView } from './PackingListView';

const DISPATCH = '00000000-0000-0000-0000-000000000501';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const pathWithQuery = String(url).replace(/^.*\/api/, '');
    const path = pathWithQuery.split('?')[0]!;
    const bodies: Record<string, unknown> = {
      '/dispatches': {
        rows: [{ id: DISPATCH, challan_no: 'DC/26-27/19', challan_date: '2026-08-22',
          party_name: 'Aarav Garments', pieces: 2, value: 14500, invoiced: false }],
        total: 1, limit: 50, offset: 0
      },
      [`/dispatches/${DISPATCH}/packing-list`]: {
        challan_no: 'DC/26-27/19', challan_date: '2026-08-22', lr_no: 'LR-88', lr_date: '2026-08-22',
        vehicle_no: 'MH04AB1234', status: 'approved', consignor_name: 'Neelkamal Textiles',
        consignor_gstin: '27ANBPC3604Q1Z0', consignor_address: 'Mill Road', consignor_address2: null,
        consignor_city: 'Bhiwandi', consignor_pincode: '421302', customer_name: 'Aarav Garments',
        customer_gstin: '27ABCDE1234F1Z5', delivery_name: 'Aarav Garments Warehouse',
        delivery_gstin: '27ABCDE1234F1Z5', delivery_address: 'Market Yard', delivery_city: 'Mumbai',
        delivery_pincode: '400001', delivery_state: '27', transport_name: 'Fast Transport',
        transporter_gstin: null, pieces: 2, total_qty: 195, total_value: 14500,
        lines: [
          { sno: 1, barcode: 'NK000101', lot_no: 'LOT-8', grade_code: 'A', uom: 'MTR',
            quality: 'Galaxy', construction: '40x40', hsn_code: '551311', design: 'Plain', qty: 100 },
          { sno: 2, barcode: 'NK000102', lot_no: 'LOT-8', grade_code: 'B', uom: 'MTR',
            quality: 'Galaxy', construction: '40x40', hsn_code: '551311', design: null, qty: 95 }
        ]
      }
    };
    return { ok: true, status: 200, headers: new Headers(),
      text: async () => JSON.stringify(bodies[path] ?? []) } as Response;
  }));
});

describe('PackingListView', () => {
  test('opens the dispatch-derived, piece-wise packing list', async () => {
    render(<PackingListView />);
    fireEvent.click(await screen.findByTitle('Print packing list DC/26-27/19'));
    expect(await screen.findByRole('heading', { name: 'PACKING LIST' })).toBeInTheDocument();
    expect(screen.getByText('NK000101')).toBeInTheDocument();
    expect(screen.getByText('NK000102')).toBeInTheDocument();
    expect(screen.getByText('195.00')).toBeInTheDocument();
    expect(screen.getByText('Aarav Garments Warehouse')).toBeInTheDocument();
    expect(screen.getByText('MH04AB1234')).toBeInTheDocument();
  });
});
