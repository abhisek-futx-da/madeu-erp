import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OnboardingView } from './OnboardingView';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, '').split('?')[0]!;
    let body: unknown = [];
    if (path === '/onboarding/imports/preview' && init?.method === 'POST') {
      body = { id: '00000000-0000-0000-0000-000000000001', totalRows: 1, validRows: 1,
        errorRows: 0, rows: [{ row_no: 2, raw_data: { code: 'I1', name: 'Imported' },
          normalized_data: { code: 'I1', name: 'Imported', sort_order: 9 }, action: 'insert', errors: [] }] };
    } else if (path.endsWith('/apply') && init?.method === 'POST') {
      body = { appliedRows: 1, status: 'applied' };
    }
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('OnboardingView', () => {
  test('previews a CSV and applies only the clean, reviewed batch', async () => {
    const { container } = render(<OnboardingView />);
    fireEvent.change(screen.getByLabelText('Master to import'), { target: { value: 'grades' } });
    const file = { name: 'grades.csv', size: 60, text: async () => 'code,name,sort_order\nI1,Imported,9\n' };
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    expect(await screen.findByText(/1 row\(s\) loaded locally/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Preview 1 row/ }));
    expect(await screen.findByText('New code will be inserted')).toBeInTheDocument();
    const apply = screen.getByRole('button', { name: 'Apply clean batch' });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/apply'))).toBe(true));
    expect(await screen.findByText(/1 row\(s\) applied in one complete transaction/)).toBeInTheDocument();
  });
});
