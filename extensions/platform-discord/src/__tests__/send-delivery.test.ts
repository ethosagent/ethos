import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DiscordAdapter } from '../index';
import { loadDiscordSdk } from '../sdk';

// What `send()` reports is the gateway delivery ledger's only evidence. A
// `{ ok: false }` after text already reached the channel makes the ledger's
// sweep post that text again; a refusal no retry can fix must say so
// (`DeliveryResult.permanent`) so the sweep stops at once.

beforeAll(async () => {
  await loadDiscordSdk();
});

/** A real (never logged-in) client with `channels.fetch` swapped for a stub. */
function makeAdapter(channelSend: (payload: { content?: string }) => Promise<{ id: string }>) {
  const adapter = new DiscordAdapter({ token: 'fake-token', botKey: 'test-bot' });
  const send = vi.fn(channelSend);
  const fetch = vi.fn(async (_id: string) => ({ send }));
  (adapter as unknown as { client: { channels: unknown } }).client = {
    channels: { fetch },
  } as never;
  return { adapter, send, fetch };
}

/** The shape discord.js's `DiscordAPIError` carries. */
function apiError(status: number, code: number, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

const LONG = `${'a'.repeat(1990)} ${'b'.repeat(1990)} ${'c'.repeat(100)}`;

describe('DiscordAdapter.send — partial delivery', () => {
  it('a later chunk failing after the first landed is reported delivered, not retryable', async () => {
    let n = 0;
    const { adapter, send } = makeAdapter(async () => {
      n++;
      if (n === 2) throw apiError(500, 0, 'Internal Server Error');
      return { id: `m${n}` };
    });
    const res = await adapter.send('chan-1', { text: LONG });
    expect(send).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe('m1');
    expect(res.error).toMatch(/partial: 1 of 3 chunks/);
  });

  it('bookkeeping failing after every chunk landed does not turn a delivery into a failure', async () => {
    const { adapter } = makeAdapter(async () => ({ id: 'm1' }));
    (adapter as unknown as { threadState: unknown }).threadState = {
      recordPost: vi.fn(async () => {
        throw new Error('disk full');
      }),
    };
    const res = await adapter.send('chan-1', { text: 'hello', threadId: 'thread-1' });
    expect(res).toEqual({ ok: true, messageId: 'm1' });
  });

  it('the first chunk failing is still a plain failure', async () => {
    const { adapter } = makeAdapter(async () => {
      throw apiError(500, 0, 'Internal Server Error');
    });
    const res = await adapter.send('chan-1', { text: 'hello' });
    expect(res.ok).toBe(false);
    expect(res.permanent).toBeUndefined();
  });
});

describe('DiscordAdapter.send — permanent refusals', () => {
  it.each([
    [403, 50001, 'Missing Access'],
    [403, 50013, 'Missing Permissions'],
    [403, 50007, 'Cannot send messages to this user'],
    [404, 10003, 'Unknown Channel'],
  ])('HTTP %i / code %i is permanent', async (status, code, message) => {
    const { adapter } = makeAdapter(async () => {
      throw apiError(status, code, message);
    });
    const res = await adapter.send('chan-1', { text: 'hello' });
    expect(res).toMatchObject({ ok: false, error: message, permanent: true });
  });

  it('a channel that cannot be fetched is permanent', async () => {
    const { adapter, fetch } = makeAdapter(async () => ({ id: 'm1' }));
    fetch.mockRejectedValueOnce(apiError(404, 10003, 'Unknown Channel'));
    expect(await adapter.send('gone', { text: 'hello' })).toMatchObject({
      ok: false,
      permanent: true,
    });
    fetch.mockResolvedValueOnce(null as never);
    expect(await adapter.send('gone', { text: 'hello' })).toMatchObject({
      ok: false,
      permanent: true,
    });
  });

  it('a rate limit or server error is not permanent', async () => {
    for (const status of [429, 500, 502]) {
      const { adapter } = makeAdapter(async () => {
        throw apiError(status, 0, `HTTP ${status}`);
      });
      const res = await adapter.send('chan-1', { text: 'hello' });
      expect(res.ok).toBe(false);
      expect(res.permanent).toBeUndefined();
    }
  });
});
