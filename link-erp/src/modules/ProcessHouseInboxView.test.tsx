import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ProcessHouseInboxView } from './ProcessHouseInboxView';
import type { Session } from '../lib/api';

/**
 * The mill's half of the conversation. What matters here is that answering is
 * deliberate — a refusal needs a reason — and that the screen never suggests
 * accepting a declaration has moved any stock.
 */

const session = (role: string): Session => ({
  userId: 'u1', tenantId: 't1', role,
  tenant: { legalName: 'Neelkamal Textiles', gstin: '27ANBPC3604Q1Z0', fyLabel: '2026-27' },
  user: { email: `${role}@neelkamal.test`, fullName: role }
} as Session);

const ROW = {
  declaration_id: 'd1', kind: 'rejection', party: 'Prayag Texprint Llp', their_ref: '',
  vehicle_no: null, expected_on: null, note: 'off-shade after first bath',
  declared_at: '2026-08-25T06:00:00Z', declared_by: 'Prayag desk',
  entry_no: 'DI/26-27/9', challan_no: 'PC-771', state: 'submitted',
  waiting_days: 2, pieces: 1
};

const DETAIL = {
  declaration: ROW,
  lines: [{ barcode: 'NKT001', qty: 100, reason: 'shade mismatch', quality: 'Galaxy', lot_no: '1100/B' }],
  history: []
};

const posted: { path: string; body: any }[] = [];

function mockApi(routes: Record<string, unknown>) {
  posted.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, '');
    const bare = path.split('?')[0]!;
    const method = init?.method ?? 'GET';
    if (method !== 'GET') posted.push({ path: bare, body: JSON.parse(String(init?.body ?? 'null')) });
    const body = routes[`${method} ${bare}`] ?? routes[bare] ?? [];
    return {
      ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body)
    } as unknown as Response;
  }));
}

beforeEach(() => {
  mockApi({
    '/party-declarations': [ROW],
    '/party-declarations/d1': DETAIL,
    '/portal-users': [],
    '/ledgers': [],
    '/control-accounts': []
  });
});

describe('the inbox', () => {
  test('shows what a process house said and how long it has waited', async () => {
    render(<ProcessHouseInboxView session={session('store')} />);
    await waitFor(() => expect(screen.getByText('Prayag Texprint Llp')).toBeInTheDocument());
    expect(screen.getByText('Damaged or off-shade')).toBeInTheDocument();
    expect(screen.getByText('PC-771')).toBeInTheDocument();
    expect(screen.getByText('2d ago')).toBeInTheDocument();
  });

  test('opening one shows the thaans and the reason they gave', async () => {
    render(<ProcessHouseInboxView session={session('store')} />);
    await waitFor(() => expect(screen.getByText('Prayag Texprint Llp')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Damaged or off-shade'));

    await waitFor(() => expect(screen.getByText('NKT001')).toBeInTheDocument());
    expect(screen.getByText('shade mismatch')).toBeInTheDocument();
    expect(screen.getByText(/does not move stock/)).toBeInTheDocument();
  });

  test('accepting posts the answer', async () => {
    vi.stubGlobal('prompt', vi.fn(() => 'agreed'));
    mockApi({
      '/party-declarations': [ROW],
      '/party-declarations/d1': DETAIL,
      'POST /party-declarations/d1/accept': { party: 'Prayag Texprint Llp', state: 'accepted' },
      '/portal-users': [], '/ledgers': [], '/control-accounts': []
    });
    render(<ProcessHouseInboxView session={session('store')} />);
    await waitFor(() => expect(screen.getByText('Prayag Texprint Llp')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.path).toBe('/party-declarations/d1/accept');
  });

  test('sending one back without a reason posts nothing', async () => {
    vi.stubGlobal('prompt', vi.fn(() => null));
    render(<ProcessHouseInboxView session={session('store')} />);
    await waitFor(() => expect(screen.getByText('Prayag Texprint Llp')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
    expect(posted).toHaveLength(0);
  });

  test('an answered declaration offers no buttons', async () => {
    mockApi({
      '/party-declarations': [{ ...ROW, state: 'accepted' }],
      '/portal-users': [], '/ledgers': [], '/control-accounts': []
    });
    render(<ProcessHouseInboxView session={session('store')} />);
    await waitFor(() => expect(screen.getByText('Prayag Texprint Llp')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });
});

describe('handing out logins', () => {
  test('only the owner sees the login panel', async () => {
    render(<ProcessHouseInboxView session={session('store')} />);
    await waitFor(() => expect(screen.getByText('Prayag Texprint Llp')).toBeInTheDocument());
    expect(screen.queryByText('Process-house logins')).toBeNull();
  });

  test('the owner is told where the process house signs in', async () => {
    render(<ProcessHouseInboxView session={session('owner')} />);
    await waitFor(() => expect(screen.getByText('Process-house logins')).toBeInTheDocument());
    expect(screen.getByText('/#portal')).toBeInTheDocument();
    expect(screen.getByText(/cannot move stock or see any money/)).toBeInTheDocument();
  });

  test('a short first password will not create a login', async () => {
    mockApi({
      '/party-declarations': [], '/portal-users': [],
      '/ledgers': [{ id: 'l1', name: 'Prayag Texprint Llp', control_account_id: 'c1' }],
      '/control-accounts': [{ id: 'c1', nature: 'sundry_creditor_process' }]
    });
    render(<ProcessHouseInboxView session={session('owner')} />);
    await waitFor(() => expect(screen.getByText('Process-house logins')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Process house'), { target: { value: 'l1' } });
    fireEvent.change(screen.getByLabelText('Their email'), { target: { value: 'a@b.test' } });
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: 'Desk' } });
    fireEvent.change(screen.getByLabelText('First password'), { target: { value: 'short' } });
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('First password'), { target: { value: 'long-enough-password' } });
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });
});
