import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReprocessView } from './ReprocessView';

const PROCESS = '00000000-0000-0000-0000-000000000201';
const CONTROL = '00000000-0000-0000-0000-000000000202';
const PIECE = '00000000-0000-0000-0000-000000000203';
const REPROCESS = '00000000-0000-0000-0000-000000000204';
const sent: { path: string; body: any }[] = [];

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const pathWithQuery = String(url).replace(/^.*\/api/, '');
    const path = pathWithQuery.split('?')[0]!;
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}'));
      sent.push({ path, body });
      const response = path === '/dyeing-reprocesses'
        ? { id: REPROCESS, issueNo: 'RP/26-27/8', pieces: 1, qty: 95 }
        : { id: 'receipt', receiptNo: 'RR/26-27/4', status: 'pending_approval', pieces: 1, amount: 186 };
      return { ok: true, status: 201, headers: new Headers(), text: async () => JSON.stringify(response) } as Response;
    }
    const bodies: Record<string, unknown> = {
      '/ledgers': [{ id: PROCESS, name: 'Prayag Texprint', control_account_id: CONTROL, code: '201' }],
      '/control-accounts': [{ id: CONTROL, nature: 'sundry_creditor_process' }],
      '/grades': [{ code: 'A', name: 'Fresh', sort_order: 1 }, { code: 'B', name: 'Second', sort_order: 2 }],
      '/pieces': [{ id: PIECE, barcode: 'RP0008', quality: 'Galaxy', grade_code: 'A',
        current_qty: 95, status: 'received_finish', uom: 'MTR' }],
      '/dyeing-reprocesses': { rows: [{ id: REPROCESS, issue_no: 'RP/26-27/7', issue_date: '2026-08-20',
        challan_no: 'PH-77', challan_date: '2026-08-20', reason: 'shade correction', status: 'approved',
        process_house_id: PROCESS, process_house: 'Prayag Texprint', lines: [{ id: 'line', sno: 1,
          issued_qty: 95, original_grade: 'A', barcode: 'RP0007', status: 'reprocess_at_process_house',
          quality: 'Galaxy', receipt_no: null, receipt_status: null, received_qty: null,
          additional_rate: null, finish_grade: null }] }], total: 1, limit: 50, offset: 0 }
    };
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(bodies[path] ?? []) } as Response;
  }));
});

describe('ReprocessView', () => {
  test('scans rejected finish and posts a correction challan', async () => {
    render(<ReprocessView />);
    await screen.findByRole('option', { name: 'Prayag Texprint' });
    fireEvent.change(screen.getByLabelText('Reprocess house'), { target: { value: PROCESS } });
    fireEvent.change(screen.getByLabelText('Reprocess challan number'), { target: { value: 'RP-OUT-8' } });
    fireEvent.change(screen.getByLabelText('Reprocess reason'), { target: { value: 'shade mismatch' } });
    fireEvent.change(screen.getByLabelText('Scan finish barcode for reprocess'), { target: { value: 'RP0008' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add scan' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Post reprocess issue' }));

    await waitFor(() => expect(sent.some(call => call.path === '/dyeing-reprocesses')).toBe(true));
    const call = sent.find(item => item.path === '/dyeing-reprocesses')!;
    expect(call.body).toEqual(expect.objectContaining({ processHouseId: PROCESS,
      challanNo: 'RP-OUT-8', reason: 'shade mismatch', barcodes: ['RP0008'] }));
    expect(await screen.findByText(/RP\/26-27\/8 posted/i)).toBeInTheDocument();
  });

  test('records corrected metres, grade, and only the incremental rate for approval', async () => {
    render(<ReprocessView />);
    const select = await screen.findByLabelText('Open reprocess challan');
    fireEvent.change(select, { target: { value: REPROCESS } });
    fireEvent.change(screen.getByLabelText('Reprocess receipt challan number'), { target: { value: 'PH-RR-4' } });
    fireEvent.change(screen.getByLabelText('Scan returned reprocess barcode'), { target: { value: 'RP0007' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add scan' })[1]!);
    fireEvent.change(screen.getByLabelText('Received quantity for RP0007'), { target: { value: '93' } });
    fireEvent.change(screen.getByLabelText('Additional rate for RP0007'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Finish grade for RP0007'), { target: { value: 'B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit receipt' }));

    await waitFor(() => expect(sent.some(call => call.path === '/dyeing-reprocess-receipts')).toBe(true));
    const call = sent.find(item => item.path === '/dyeing-reprocess-receipts')!;
    expect(call.body.lines).toEqual([{ barcode: 'RP0007', receivedQty: 93, additionalRate: 2, finishGrade: 'B' }]);
    expect(await screen.findByText(/wait for a second person/i)).toBeInTheDocument();
  });
});
