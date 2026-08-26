import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { OfflineQueueView } from './OfflineQueueView';
import * as queue from '../lib/offlineQueue';

vi.mock('../lib/offlineQueue', () => ({
  pending: vi.fn(),
  heldForReview: vi.fn(),
  retryHeld: vi.fn(),
  discardHeld: vi.fn(),
  flush: vi.fn(),
  isOnline: vi.fn(() => true)
}));

const HELD = {
  id: 'h1', path: '/grey-inwards', queuedAt: 1787000000000, attempts: 1,
  lastError: 'barcode already in use: NKT004',
  heldForReview: true, heldAt: 1787000100000,
  body: { lines: [{ barcode: 'NKT004' }, { barcode: 'NKT005' }] }
};

const WAITING = {
  id: 'w1', path: '/cut-pack', queuedAt: 1787000200000, attempts: 0,
  body: { barcodes: ['NKT010', 'NKT011', 'NKT012'] }
};

const mocked = queue as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  mocked.pending.mockResolvedValue([WAITING]);
  mocked.heldForReview.mockResolvedValue([HELD]);
  mocked.isOnline.mockReturnValue(true);
});

describe('what is waiting', () => {
  test('says what each scan was, in words a storekeeper uses', async () => {
    render(<OfflineQueueView />);
    await waitFor(() => expect(screen.getByText('Cut / pack — 3 piece(s)')).toBeInTheDocument());
    expect(screen.getByText('Grey inward — 2 piece(s)')).toBeInTheDocument();
  });

  test('an empty queue says so plainly', async () => {
    mocked.pending.mockResolvedValue([]);
    mocked.heldForReview.mockResolvedValue([]);
    render(<OfflineQueueView />);
    await waitFor(() =>
      expect(screen.getByText(/Every scan has reached the server/)).toBeInTheDocument());
  });

  test('offline is stated, not implied by a disabled button', async () => {
    mocked.isOnline.mockReturnValue(false);
    render(<OfflineQueueView />);
    await waitFor(() => expect(screen.getByText(/No network\./)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();
  });
});

describe('what the server refused', () => {
  test('shows the reason, not just a count', async () => {
    render(<OfflineQueueView />);
    await waitFor(() =>
      expect(screen.getByText('barcode already in use: NKT004')).toBeInTheDocument());
    expect(screen.getByText(/1 scan\(s\) the server refused/)).toBeInTheDocument();
    expect(screen.getByText(/will not be sent again on their own/)).toBeInTheDocument();
  });

  test('trying again puts it back in the queue', async () => {
    mocked.retryHeld.mockResolvedValue(true);
    render(<OfflineQueueView />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(mocked.retryHeld).toHaveBeenCalledWith('h1'));
  });

  test('discarding asks first, and says nothing is undone', async () => {
    const confirm = vi.fn((_message?: string) => false);
    vi.stubGlobal('confirm', confirm);
    render(<OfflineQueueView />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Discard/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Discard/ }));
    expect(confirm).toHaveBeenCalled();
    expect(String(confirm.mock.calls[0]![0])).toMatch(/never recorded, so nothing is/);
    expect(mocked.discardHeld).not.toHaveBeenCalled();
  });

  test('discarding goes ahead once confirmed', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    mocked.discardHeld.mockResolvedValue(undefined);
    render(<OfflineQueueView />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Discard/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Discard/ }));
    await waitFor(() => expect(mocked.discardHeld).toHaveBeenCalledWith('h1'));
  });

  test('no refusals means no red panel at all', async () => {
    mocked.heldForReview.mockResolvedValue([]);
    render(<OfflineQueueView />);
    await waitFor(() => expect(screen.getByText(/Cut \/ pack/)).toBeInTheDocument());
    expect(screen.queryByText(/the server refused/)).toBeNull();
  });
});

describe('sending', () => {
  test('reports what happened to each scan', async () => {
    mocked.flush.mockResolvedValue({ sent: 2, failed: 1, rejected: [HELD] });
    render(<OfflineQueueView />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Save/ })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() =>
      expect(screen.getByText(/2 sent, 1 refused and held for you, 1 still waiting/))
        .toBeInTheDocument());
  });
});
