import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ContraEntryView } from './ContraEntryView';
import { clearApiCache } from '../lib/useApi';

/**
 * A contra moves the mill's own money. The screen's job is to offer only cash
 * and bank accounts, refuse a transfer to the same account, and never let a
 * party appear — putting a supplier here is exactly the mistake this screen
 * exists to stop.
 */
const posted: any[] = [];

function mockApi() {
  clearApiCache();
  posted.length = 0;
  const routes: Record<string, unknown> = {
    '/control-accounts': [
      { id: 'c-cash', nature: 'cash' },
      { id: 'c-bank', nature: 'bank' },
      { id: 'c-cred', nature: 'sundry_creditor_grey' }
    ],
    '/ledgers': [
      { id: 'l-cash', code: '970', name: 'Cash In Hand', control_account_id: 'c-cash' },
      { id: 'l-hdfc', code: '971', name: 'HDFC Bank - Current', control_account_id: 'c-bank' },
      { id: 'l-weaver', code: '105', name: 'L.R. Textiles', control_account_id: 'c-cred' }
    ],
    '/contra-entries': { rows: [] }
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, '').split('?')[0]!;
    if (init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)));
      return {
        ok: true, status: 201, headers: new Headers(),
        text: async () => JSON.stringify({
          entryNo: 'CN-1', amount: 25000, from: 'Cash In Hand', to: 'HDFC Bank - Current'
        })
      } as Response;
    }
    return { ok: true, status: 200, headers: new Headers(),
             text: async () => JSON.stringify(routes[path] ?? []) } as Response;
  }));
}

beforeEach(() => mockApi());

describe('ContraEntryView', () => {
  test('offers cash and bank accounts, and no party at all', async () => {
    render(<ContraEntryView />);
    await waitFor(() =>
      expect(screen.getAllByRole('option', { name: /Cash In Hand/ }).length).toBeGreaterThan(0));

    expect(screen.getAllByRole('option', { name: /HDFC Bank/ }).length).toBeGreaterThan(0);
    // A weaver is not the mill's own money, and must not be selectable.
    expect(screen.queryByRole('option', { name: /L.R. Textiles/ })).not.toBeInTheDocument();
  });

  test('an account cannot send money to itself', async () => {
    render(<ContraEntryView />);
    await waitFor(() => expect(screen.getByLabelText(/From/)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/From/), { target: { value: 'l-cash' } });
    // The From choice is removed from To, so the same account cannot be picked.
    const to = screen.getByLabelText(/To/) as HTMLSelectElement;
    expect([...to.options].map(o => o.value)).not.toContain('l-cash');
  });

  test('will not post without both ends and an amount', async () => {
    render(<ContraEntryView />);
    const save = () => screen.getByRole('button', { name: /Post contra/ });
    await waitFor(() => expect(save()).toBeDisabled());

    fireEvent.change(screen.getByLabelText(/From/), { target: { value: 'l-cash' } });
    expect(save()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/To/), { target: { value: 'l-hdfc' } });
    expect(save()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '25000' } });
    expect(save()).toBeEnabled();
  });

  test('posts the transfer and says what moved where', async () => {
    render(<ContraEntryView />);
    await waitFor(() => expect(screen.getByLabelText(/From/)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/From/), { target: { value: 'l-cash' } });
    fireEvent.change(screen.getByLabelText(/To/), { target: { value: 'l-hdfc' } });
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '25000' } });
    fireEvent.change(screen.getByLabelText(/Cheque/), { target: { value: 'DEP-9' } });
    fireEvent.click(screen.getByRole('button', { name: /Post contra/ }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      fromLedgerId: 'l-cash', toLedgerId: 'l-hdfc', amount: 25000, instrumentNo: 'DEP-9'
    });
    expect(await screen.findByRole('status'))
      .toHaveTextContent(/from Cash In Hand to HDFC Bank/);
  });

  test('a refusal from the server is shown, not swallowed', async () => {
    render(<ContraEntryView />);
    await waitFor(() => expect(screen.getByLabelText(/From/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/From/), { target: { value: 'l-cash' } });
    fireEvent.change(screen.getByLabelText(/To/), { target: { value: 'l-hdfc' } });
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '25000' } });

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 400, headers: new Headers(), statusText: 'Bad Request',
      text: async () => JSON.stringify({ error: 'a contra moves the mill\'s own money' })
    } as Response)));

    fireEvent.click(screen.getByRole('button', { name: /Post contra/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/own money/);
  });
});
