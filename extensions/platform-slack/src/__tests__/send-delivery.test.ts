// What `send()` reports is the gateway delivery ledger's only evidence. A
// `{ ok: false }` after text already reached the channel makes the ledger's
// sweep post that text again; a refusal no retry can fix must say so
// (`DeliveryResult.permanent`) so the sweep stops at once.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SlackAdapter } from '../adapter';
import { loadSlackSdk } from '../sdk';
import { stubSlackWebApi } from './stub-slack-web-api';

beforeAll(async () => {
  await loadSlackSdk();
});

stubSlackWebApi();

function makeAdapter(
  postMessage: (args: Record<string, unknown>) => Promise<{ ts?: string }>,
  opts: { longReplyThresholdChars?: number } = {},
) {
  const adapter = new SlackAdapter({
    botToken: 'xoxb-fake',
    appToken: 'xapp-fake',
    signingSecret: 'sig-fake',
    botKey: 'test-bot',
    longReplyThresholdChars: opts.longReplyThresholdChars ?? 0,
  });
  const post = vi.fn(postMessage);
  const uploadV2 = vi.fn(async () => ({ files: [{ ts: '1.9' }] }));
  (adapter as unknown as { client: unknown }).client = {
    chat: { postMessage: post, update: vi.fn(async () => ({ ok: true })), delete: vi.fn() },
    files: { uploadV2 },
    reactions: { add: vi.fn(), remove: vi.fn() },
  } as never;
  return { adapter, post, uploadV2 };
}

/** The shape @slack/web-api throws for an `ok: false` Web API response. */
function platformError(error: string): Error {
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error },
  });
}

const TWO_CHUNKS = `${'a'.repeat(2990)} ${'b'.repeat(2990)} ${'c'.repeat(50)}`;

describe('SlackAdapter.send — partial delivery', () => {
  it('a later chunk failing after the first landed is reported delivered, not retryable', async () => {
    let n = 0;
    const { adapter, post } = makeAdapter(async () => {
      n++;
      if (n === 2) throw platformError('internal_error');
      return { ts: `1.${n}` };
    });
    const res = await adapter.send('C1', { text: TWO_CHUNKS });
    expect(post).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe('1.1');
    expect(res.error).toMatch(/partial: 1 of 3 chunks/);
  });

  it('bookkeeping failing after the reply landed does not turn it into a failure', async () => {
    const { adapter } = makeAdapter(async () => ({ ts: '1.1' }));
    (adapter as unknown as { threadState: unknown }).threadState = {
      recordPost: vi.fn(async () => {
        throw new Error('disk full');
      }),
    };
    const res = await adapter.send('C1', { text: 'hi', threadId: '1.0' });
    expect(res).toEqual({ ok: true, messageId: '1.1' });
  });

  it('a long answer whose lead posted but whose reflow then failed is reported delivered', async () => {
    let n = 0;
    const { adapter, uploadV2 } = makeAdapter(
      async () => {
        n++;
        if (n > 1) throw platformError('internal_error');
        return { ts: `1.${n}` };
      },
      { longReplyThresholdChars: 100 },
    );
    uploadV2.mockRejectedValueOnce(new Error('missing_scope'));
    const res = await adapter.send('C1', { text: TWO_CHUNKS });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe('1.1');
    expect(res.error).toMatch(/partial/);
  });
});

describe('SlackAdapter.send — permanent refusals', () => {
  it.each(['channel_not_found', 'not_in_channel', 'is_archived', 'account_inactive'])(
    '%s is permanent',
    async (code) => {
      const { adapter } = makeAdapter(async () => {
        throw platformError(code);
      });
      const res = await adapter.send('C1', { text: 'hi' });
      expect(res).toMatchObject({ ok: false, permanent: true });
      expect(res.error).toContain(code);
    },
  );

  it('rate limits and transient errors are not permanent', async () => {
    for (const code of ['ratelimited', 'internal_error', 'fatal_error']) {
      const { adapter } = makeAdapter(async () => {
        throw platformError(code);
      });
      const res = await adapter.send('C1', { text: 'hi' });
      expect(res.ok).toBe(false);
      expect(res.permanent).toBeUndefined();
    }
  });

  it('a voice note to an archived channel is permanent', async () => {
    const { adapter, uploadV2 } = makeAdapter(async () => ({ ts: '1.1' }));
    uploadV2.mockRejectedValueOnce(platformError('is_archived'));
    const res = await adapter.sendVoiceNote('C1', new Uint8Array([1]), {
      format: 'mp3',
      mimeType: 'audio/mpeg',
      filename: 'v.mp3',
    });
    expect(res).toMatchObject({ ok: false, permanent: true });
  });
});
