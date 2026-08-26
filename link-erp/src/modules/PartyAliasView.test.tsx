import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PartyAliasView } from './PartyAliasView';

/**
 * What each customer calls our cloth. The screen's job is to make it obvious
 * that this changes what *their* documents print and nothing about our own
 * stock, and to refuse an alias that says nothing.
 */

const posted: { path: string; method: string; body: any }[] = [];

function mockApi(over: Record<string, unknown> = {}) {
  posted.length = 0;
  const routes: Record<string, unknown> = {
    '/party-aliases': [{
      id: 'a1', party_id: 'p1', party: 'Supreme Textile And Garments',
      quality_id: 'q1', quality: 'Galaxy', design_id: null, design: null,
      their_quality: 'SUPREME COTTON 58"', their_design: '', notes: 'their catalogue'
    }],
    '/ledgers': [{ id: 'p1', name: 'Supreme Textile And Garments', control_account_id: 'c1' }],
    '/qualities': [{ id: 'q1', name: 'Galaxy' }],
    '/designs': [{ id: 'd1', quality_id: 'q1', name: '50-Super Cotton' }],
    ...over
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const bare = String(url).replace(/^.*\/api/, '').split('?')[0]!;
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      posted.push({ path: bare, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    }
    return {
      ok: true, status: 200, headers: new Headers(),
      text: async () => JSON.stringify(routes[bare] ?? [])
    } as unknown as Response;
  }));
}

beforeEach(() => mockApi());

describe('customer names', () => {
  test('shows our name and theirs side by side', async () => {
    render(<PartyAliasView />);
    await waitFor(() =>
      expect(screen.getByText('SUPREME COTTON 58"')).toBeInTheDocument());
    // 'Galaxy' appears in the table and in the quality picker; the row is the point.
    expect(screen.getAllByText('Galaxy').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Supreme Textile And Garments').length).toBeGreaterThan(0);
  });

  test('an empty list says every document prints our own name', async () => {
    mockApi({ '/party-aliases': [] });
    render(<PartyAliasView />);
    await waitFor(() =>
      expect(screen.getByText(/every document prints ours/)).toBeInTheDocument());
  });

  test('saving needs a customer, a quality and at least one of their names', async () => {
    render(<PartyAliasView />);
    await waitFor(() => expect(screen.getByLabelText('Customer')).toBeInTheDocument());
    const save = () => screen.getByRole('button', { name: /Save/ });

    expect(save()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'p1' } });
    expect(save()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Our quality'), { target: { value: 'q1' } });
    expect(save()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('They call it'), { target: { value: 'THEIR NAME' } });
    expect(save()).toBeEnabled();
  });

  test('a design list only offers designs of the chosen quality', async () => {
    render(<PartyAliasView />);
    await waitFor(() => expect(screen.getByLabelText('Our design')).toBeDisabled());

    fireEvent.change(screen.getByLabelText('Our quality'), { target: { value: 'q1' } });
    expect(screen.getByLabelText('Our design')).toBeEnabled();
    expect(screen.getByRole('option', { name: '50-Super Cotton' })).toBeInTheDocument();
  });

  test('saving sends the scope and the name', async () => {
    render(<PartyAliasView />);
    await waitFor(() => expect(screen.getByLabelText('Customer')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Our quality'), { target: { value: 'q1' } });
    fireEvent.change(screen.getByLabelText('They call it'), { target: { value: ' SUPREME 60 ' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toMatchObject({
      partyId: 'p1', qualityId: 'q1', designId: null, theirQuality: 'SUPREME 60'
    });
  });

  test('removing one warns that their documents revert to our name', async () => {
    const confirm = vi.fn((_m?: string) => false);
    vi.stubGlobal('confirm', confirm);
    render(<PartyAliasView />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Remove alias/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Remove alias/ }));
    expect(String(confirm.mock.calls[0]![0])).toMatch(/back to our own name, Galaxy/);
    expect(posted).toHaveLength(0);
  });
});
