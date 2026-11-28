import { type InitiativeDigest, parseInitiativeAction } from '@ethosagent/types';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SlackAdapter } from '../adapter';
import { loadSlackSdk } from '../sdk';
import { stubSlackWebApi } from './stub-slack-web-api';

// `SlackAdapter.sendInitiativeDigest`: Block Kit with `init:` action ids (the ids
// initiative-adapter.test.ts routes), the Markdown as alt text, and the text send as the fallback.

beforeAll(async () => {
  await loadSlackSdk();
});

stubSlackWebApi();

function make(post: (args: Record<string, unknown>) => Promise<{ ts?: string }>) {
  const adapter = new SlackAdapter({
    botToken: 'xoxb-fake',
    appToken: 'xapp-fake',
    signingSecret: 'sig-fake',
    botKey: 'test-bot',
  });
  const postMessage = vi.fn(post);
  (adapter as unknown as { client: unknown }).client = {
    chat: { postMessage, update: vi.fn(), delete: vi.fn() },
    files: { uploadV2: vi.fn() },
    reactions: { add: vi.fn(), remove: vi.fn() },
  };
  return { adapter, postMessage };
}

const digest = (over: Partial<InitiativeDigest> = {}): InitiativeDigest => ({
  personalityId: 'pm',
  generatedAt: '2026-11-28T08:00:00.000Z',
  since: '2026-11-27T08:00:00.000Z',
  ownWork: { windows: 0, spentUsd: 0, explorations: [] },
  needsYes: [{ explorationId: 'EXP-0002', question: 'q2', estimateUsd: 0.5 }],
  agentInitiatives: [],
  briefs: [],
  questions: [],
  suggestions: [],
  ...over,
});

describe('SlackAdapter.sendInitiativeDigest', () => {
  it('digest send produces blocks carrying init: action ids, with the Markdown as alt text', async () => {
    const { adapter, postMessage } = make(async () => ({ ts: '1.1' }));
    const res = await adapter.sendInitiativeDigest('C1', digest(), {
      text: '## md fallback',
      threadId: '9.9',
    });
    expect(res).toEqual({ ok: true, messageId: '1.1' });
    const args = postMessage.mock.calls[0]?.[0] as {
      blocks: Array<{ type: string; elements?: Array<{ action_id: string }> }>;
      text: string;
      thread_ts: string;
      channel: string;
    };
    expect(args.channel).toBe('C1');
    expect(args.thread_ts).toBe('9.9');
    expect(args.text).toContain('md fallback');
    const ids = args.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements ?? []);
    expect(ids.map((e) => e.action_id)).toContain('init:approve:EXP-0002');
    for (const e of ids) expect(parseInitiativeAction(e.action_id)).not.toBeNull();
  });

  it('when the blocks build fails, the text fallback still delivers', async () => {
    const { adapter, postMessage } = make(async () => ({ ts: '2.2' }));
    const broken = { ...digest(), needsYes: null } as unknown as InitiativeDigest;
    const res = await adapter.sendInitiativeDigest('C1', broken, { text: 'md fallback' });
    expect(res.ok).toBe(true);
    const args = postMessage.mock.calls[0]?.[0] as { text: string; blocks?: unknown };
    expect(args.text).toContain('md fallback');
    expect(args.blocks).toBeUndefined();
  });

  it('a refused post is { ok: false }, so the ledger keeps the obligation', async () => {
    const { adapter } = make(async () => {
      throw new Error('rate_limited');
    });
    const res = await adapter.sendInitiativeDigest('C1', digest(), { text: 'md' });
    expect(res.ok).toBe(false);
  });

  const slackError = (code: string) =>
    Object.assign(new Error(`An API error occurred: ${code}`), {
      data: { ok: false, error: code },
    });

  it.each(['invalid_blocks', 'msg_too_long', 'invalid_arguments'])(
    'Slack refusing the request shape (%s) falls back to exactly one text send',
    async (code) => {
      let calls = 0;
      const { adapter, postMessage } = make(async () => {
        if (++calls === 1) throw slackError(code);
        return { ts: '3.3' };
      });
      const res = await adapter.sendInitiativeDigest('C1', digest(), { text: 'md fallback' });
      expect(res).toEqual({ ok: true, messageId: '3.3' });
      expect(postMessage).toHaveBeenCalledTimes(2);
      const second = postMessage.mock.calls[1]?.[0] as { text: string; blocks?: unknown };
      expect(second.blocks).toBeUndefined();
      expect(second.text).toContain('md fallback');
    },
  );

  it('a transient error does not fall back: the ledger sweep owns that retry', async () => {
    const { adapter, postMessage } = make(async () => {
      throw slackError('ratelimited');
    });
    const res = await adapter.sendInitiativeDigest('C1', digest(), { text: 'md' });
    expect(res.ok).toBe(false);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
