import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LiveReportView } from './LiveReportView';

describe('LiveReportView empty states', () => {
  test('a blank GST report explains what is missing and opens the right workflow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, headers: new Headers(), text: async () => '[]'
    } as unknown as Response)));
    const onOpen = vi.fn();
    render(<LiveReportView report="gst_liability" onOpen={onOpen} />);

    await waitFor(() => expect(screen.getByText(/No approved GST documents/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Open tax invoices/i }));
    expect(onOpen).toHaveBeenCalledWith('sales_invoices');
  });
});
