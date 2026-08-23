import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { GlobalSearchView } from './GlobalSearchView';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify([{
      kind: 'ledger', id: 'ledger-202', title: '202 — Prayag Texprint Llp',
      subtitle: 'Prayag · 27AABFP5678N1Z9', module: 'ledgers', filter: '202',
      status: 'active', occurred_on: '2026-08-23T10:00:00Z'
    }])
  } as Response)));
});

describe('GlobalSearchView', () => {
  test('finds an operational record and opens its module with the exact filter', async () => {
    const open = vi.fn();
    render(<GlobalSearchView onOpen={open} />);
    fireEvent.change(screen.getByLabelText('Find anything'), { target: { value: 'Prayag' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: /202 — Prayag Texprint/ }));
    expect(open).toHaveBeenCalledWith('ledgers', '202');
  });
});
