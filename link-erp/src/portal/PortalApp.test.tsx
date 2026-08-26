import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PortalApp } from './PortalApp';

/**
 * The portal is used by somebody who does not work for the mill, on a phone,
 * in someone else's office. These tests hold the two things that matter there:
 * it shows only their own goods, and every button on it files a statement
 * rather than moving stock.
 */

const CHALLAN = {
  issue_id: 'i1', entry_no: 'DI/26-27/9', challan_no: 'PC-771', challan_date: '2026-08-22',
  lot_no: '1100/B', pieces: 3, issued_qty: 300, job_rate: 18,
  acknowledged_at: null, expected_on: null, any_returned: false
};

const PIECES = [
  { piece_id: 'p1', barcode: 'NKT001', quality: 'Galaxy', design: null, lot_no: '1100/B',
    grade_code: 'LUMP', current_qty: 100, uom: 'MTR', entry_no: 'DI/26-27/9',
    challan_no: 'PC-771', issued_qty: 100 },
  { piece_id: 'p2', barcode: 'NKT002', quality: 'Galaxy', design: null, lot_no: '1100/B',
    grade_code: 'LUMP', current_qty: 100, uom: 'MTR', entry_no: 'DI/26-27/9',
    challan_no: 'PC-771', issued_qty: 100 }
];

const posted: { path: string; body: any }[] = [];

function mockApi(routes: Record<string, unknown>) {
  posted.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api\/portal/, '');
    const method = init?.method ?? 'GET';
    if (method !== 'GET') posted.push({ path, body: JSON.parse(String(init?.body ?? 'null')) });
    const body = routes[`${method} ${path}`] ?? routes[path] ?? [];
    return {
      ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body)
    } as unknown as Response;
  }));
}

const signedIn = (over: Record<string, unknown> = {}) => ({
  '/challans': [CHALLAN],
  '/pieces': PIECES,
  '/declarations': [],
  ...over
});

beforeEach(() => {
  try { sessionStorage.clear(); } catch { /* jsdom without storage */ }
  try { localStorage.clear(); } catch { /* jsdom without storage */ }
  mockApi(signedIn());
});

describe('signing in', () => {
  test('asks for a login and nothing else', () => {
    render(<PortalApp />);
    expect(screen.getByText('Process House Portal')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByText(/Challans/)).toBeNull();
  });

  test('a refusal is shown, not swallowed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 401, headers: new Headers(),
      text: async () => JSON.stringify({ error: 'invalid credentials' })
    } as unknown as Response)));

    render(<PortalApp />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } });
    fireEvent.submit(screen.getByRole('button', { name: /Sign in/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('invalid credentials'));
  });
});

describe('once signed in', () => {
  const enter = async () => {
    mockApi(signedIn({
      'POST /auth/login': { token: 't', mill: 'Neelkamal Textiles', party: 'Prayag Texprint Llp' }
    }));
    render(<PortalApp />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-password' } });
    fireEvent.submit(screen.getByRole('button', { name: /Sign in/ }));
    await waitFor(() => expect(screen.getByText('PC-771')).toBeInTheDocument());
  };

  test('shows whose goods these are and which challan they came on', async () => {
    await enter();
    expect(screen.getByText('Prayag Texprint Llp')).toBeInTheDocument();
    expect(screen.getByText(/holding goods for Neelkamal Textiles/)).toBeInTheDocument();
    expect(screen.getByText(/3 thaan\(s\)/)).toBeInTheDocument();
    expect(screen.getByText('Not confirmed')).toBeInTheDocument();
  });

  test('the thaans tab lists only what they hold', async () => {
    await enter();
    fireEvent.click(screen.getByRole('button', { name: /Thaans \(2\)/ }));
    expect(screen.getByText('NKT001')).toBeInTheDocument();
    expect(screen.getByText('NKT002')).toBeInTheDocument();
  });

  test('acknowledging custody files a declaration and says so', async () => {
    await enter();
    fireEvent.click(screen.getByRole('button', { name: /Tell the mill something/ }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Send to the mill/ }));
    await waitFor(() => expect(posted.some(p => p.path === '/declarations')).toBe(true));

    const sent = posted.find(p => p.path === '/declarations')!.body;
    expect(sent.kind).toBe('custody_ack');
    expect(sent.issueId).toBe('i1');
  });

  test('an expected return cannot be sent without a date', async () => {
    await enter();
    fireEvent.click(screen.getByRole('button', { name: /Tell the mill something/ }));
    fireEvent.change(await screen.findByLabelText(/What do you want to say/),
      { target: { value: 'expected_return' } });

    expect(screen.getByRole('button', { name: /Send to the mill/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Expected return date/), { target: { value: '2026-09-08' } });
    expect(screen.getByRole('button', { name: /Send to the mill/ })).toBeEnabled();
  });

  test('a rejection cannot be sent without naming thaans', async () => {
    await enter();
    fireEvent.click(screen.getByRole('button', { name: /Tell the mill something/ }));
    fireEvent.change(await screen.findByLabelText(/What do you want to say/),
      { target: { value: 'rejection' } });

    expect(screen.getByRole('button', { name: /Send to the mill/ })).toBeDisabled();
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(screen.getByRole('button', { name: /Send to the mill/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason for rejection NKT001/),
      { target: { value: 'off-shade after first bath' } });
    expect(screen.getByRole('button', { name: /Send to the mill/ })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /Send to the mill/ }));
    await waitFor(() => expect(posted.some(p => p.path === '/declarations')).toBe(true));
    expect(posted.find(p => p.path === '/declarations')!.body.lines).toEqual([{
      barcode: 'NKT001', qty: undefined, reason: 'off-shade after first bath'
    }]);
  });

  test('a shortage records the quantity for each named thaan', async () => {
    await enter();
    fireEvent.click(screen.getByRole('button', { name: /Tell the mill something/ }));
    fireEvent.change(await screen.findByLabelText(/What do you want to say/),
      { target: { value: 'shortage' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);

    expect(screen.getByRole('button', { name: /Send to the mill/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Short quantity NKT001/), { target: { value: '7.5' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to the mill/ }));

    await waitFor(() => expect(posted.some(p => p.path === '/declarations')).toBe(true));
    expect(posted.find(p => p.path === '/declarations')!.body.lines[0]).toEqual({
      barcode: 'NKT001', qty: 7.5, reason: undefined
    });
  });

  test('return dispatch requires their challan and vehicle', async () => {
    await enter();
    fireEvent.click(screen.getByRole('button', { name: /Tell the mill something/ }));
    fireEvent.change(await screen.findByLabelText(/What do you want to say/),
      { target: { value: 'return_dispatch' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);

    const send = screen.getByRole('button', { name: /Send to the mill/ });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Your challan/), { target: { value: 'PTX-44' } });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Vehicle/), { target: { value: 'GJ05AB1234' } });
    expect(send).toBeEnabled();
  });

  test('Hindi can be selected and clearly remains awaiting native review', () => {
    render(<PortalApp />);
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'hi' } });

    expect(screen.getByText('प्रोसेस हाउस पोर्टल')).toBeInTheDocument();
    expect(screen.getByText(/स्थानीय भाषी/)).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('hi');
  });

  test('it says plainly that nothing here moves stock', async () => {
    await enter();
    fireEvent.click(screen.getByRole('button', { name: /Tell the mill something/ }));
    expect(await screen.findByText(/It does not move stock/)).toBeInTheDocument();
  });

  test('the mill\'s answer comes back on the declaration', async () => {
    mockApi(signedIn({
      'POST /auth/login': { token: 't', mill: 'Neelkamal Textiles', party: 'Prayag Texprint Llp' },
      '/declarations': [{
        declaration_id: 'd1', kind: 'rejection', their_ref: '', vehicle_no: null,
        expected_on: null, note: 'off-shade', declared_at: '2026-08-25T06:00:00Z',
        entry_no: 'DI/26-27/9', challan_no: 'PC-771', state: 'accepted',
        mill_note: 'agreed, re-process', answered_at: '2026-08-25T09:00:00Z', pieces: 1
      }]
    }));
    render(<PortalApp />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-password' } });
    fireEvent.submit(screen.getByRole('button', { name: /Sign in/ }));

    await waitFor(() => expect(screen.getByText('PC-771')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /What I told the mill/ }));

    expect(screen.getByText('Damaged or off-shade')).toBeInTheDocument();
    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText(/agreed, re-process/)).toBeInTheDocument();
  });
});
