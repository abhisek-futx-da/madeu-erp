import 'fake-indexeddb/auto';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { enqueue, pending, heldForReview, flush, retryHeld, discardHeld } from './offlineQueue';
import { ApiError } from './api';

/**
 * The queue itself always worked. What did not was the fate of a scan the
 * *server* refused: it stayed in the browser and was re-sent every minute,
 * collecting the identical rejection forever while the badge counted up and no
 * screen said why. These tests hold the difference between "the network is
 * down, keep trying" and "the server has judged this, stop and ask a person".
 */

const post = vi.fn();

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, api: { ...actual.api, post: (p: string, b: unknown) => post(p, b) } };
});

async function drain() {
  for (const item of [...(await pending()), ...(await heldForReview())]) {
    await discardHeld(item.id);
  }
}

beforeEach(async () => {
  post.mockReset();
  await drain();
});

afterEach(async () => { await drain(); });

describe('a scan that reaches the server', () => {
  test('is sent and forgotten', async () => {
    post.mockResolvedValue({ ok: true });
    await enqueue('/cut-pack', { barcodes: ['NKT001'] });

    const r = await flush();
    expect(r.sent).toBe(1);
    expect(await pending()).toHaveLength(0);
    expect(await heldForReview()).toHaveLength(0);
  });
});

describe('a scan the network cannot deliver', () => {
  test('stays queued and is tried again', async () => {
    post.mockRejectedValue(new TypeError('Failed to fetch'));
    await enqueue('/cut-pack', { barcodes: ['NKT002'] });

    const r = await flush();
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(1);
    expect(await pending()).toHaveLength(1);
    expect(await heldForReview()).toHaveLength(0);

    post.mockResolvedValue({ ok: true });
    expect((await flush()).sent).toBe(1);
  });

  test('a 429 is the network being busy, not a judgement', async () => {
    post.mockRejectedValue(new ApiError(429, 'too many requests'));
    await enqueue('/cut-pack', { barcodes: ['NKT003'] });

    await flush();
    expect(await heldForReview()).toHaveLength(0);
    expect(await pending()).toHaveLength(1);
  });
});

describe('a scan the server refuses', () => {
  test('is held for a person instead of being re-sent forever', async () => {
    post.mockRejectedValue(new ApiError(400, 'barcode already in use: NKT004'));
    await enqueue('/grey-inwards', { lines: [{ barcode: 'NKT004' }] });

    const first = await flush();
    expect(first.rejected).toHaveLength(1);

    const held = await heldForReview();
    expect(held).toHaveLength(1);
    expect(held[0]!.lastError).toMatch(/already in use/);
    expect(await pending()).toHaveLength(0);

    // The heart of it: three more flushes must not touch the server again.
    post.mockClear();
    await flush();
    await flush();
    await flush();
    expect(post).not.toHaveBeenCalled();
    expect((await heldForReview())[0]!.attempts).toBe(1);
  });

  test('does not block the scans behind it', async () => {
    post.mockRejectedValueOnce(new ApiError(400, 'no such quality'));
    post.mockResolvedValue({ ok: true });
    await enqueue('/grey-inwards', { lines: [{ barcode: 'BAD' }] });
    await enqueue('/cut-pack', { barcodes: ['GOOD'] });

    const r = await flush();
    expect(r.rejected).toHaveLength(1);
    expect(r.sent).toBe(1);
  });
});

describe('what a person can do about it', () => {
  test('putting one back clears the error and queues it again', async () => {
    post.mockRejectedValue(new ApiError(400, 'closed period'));
    await enqueue('/dispatches', { lines: [{ barcode: 'NKT005' }] });
    await flush();

    const held = (await heldForReview())[0]!;
    expect(await retryHeld(held.id)).toBe(true);

    const queued = await pending();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.lastError).toBeUndefined();
    expect(await heldForReview()).toHaveLength(0);

    post.mockResolvedValue({ ok: true });
    expect((await flush()).sent).toBe(1);
  });

  test('discarding one removes it entirely', async () => {
    post.mockRejectedValue(new ApiError(409, 'duplicate challan'));
    await enqueue('/dyeing-issues', { barcodes: ['NKT006'] });
    await flush();

    const held = (await heldForReview())[0]!;
    await discardHeld(held.id);
    expect(await heldForReview()).toHaveLength(0);
    expect(await pending()).toHaveLength(0);
  });

  test('putting back something that is gone says so rather than throwing', async () => {
    expect(await retryHeld('no-such-id')).toBe(false);
  });
});
