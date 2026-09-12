// O-T3 (plan/phases/trust-before-reach.md) — `send_message` meets the approval
// outbox.
//
// `outbound_policy.approve_before_send` was a field nothing read: an agent's
// `send_message` reached a real channel the moment the model called it. These
// pin the four things that changed and the one that must not have — a
// deployment that wires no outbox sends exactly as it did before.

import type { Tool, ToolContext } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createMessagingTools, type OutboxGate, type OutboxProposal } from '../index';

function ctx(partial: Partial<ToolContext> = {}): ToolContext {
  return {
    personalityId: 'cmo',
    platform: 'telegram',
    sessionKey: 'telegram:marketing-bot:C9',
    ...partial,
  } as ToolContext;
}

interface Harness {
  tool: Tool;
  send: ReturnType<typeof vi.fn>;
  proposals: OutboxProposal[];
  gates: ReturnType<typeof vi.fn>;
}

function harness(
  overrides: {
    gates?: OutboxGate['gates'];
    ownerTarget?: OutboxGate['ownerTarget'];
    propose?: OutboxGate['propose'];
    getAllowedTargets?: (personalityId?: string) => string[] | null;
    outbox?: boolean;
  } = {},
): Harness {
  const send = vi.fn(async () => ({ ok: true }));
  const proposals: OutboxProposal[] = [];
  const gates = vi.fn(overrides.gates ?? (() => true));
  const outbox: OutboxGate = {
    gates,
    ownerTarget: overrides.ownerTarget ?? (() => undefined),
    propose:
      overrides.propose ??
      (async (proposal) => {
        proposals.push(proposal);
        return { ok: true, itemId: 'obx_7f3a', revision: 1 };
      }),
  };
  const tools = createMessagingTools({
    send,
    ...(overrides.getAllowedTargets ? { getAllowedTargets: overrides.getAllowedTargets } : {}),
    ...(overrides.outbox === false ? {} : { outbox }),
  });
  const tool = tools.find((t) => t.name === 'send_message');
  if (!tool) throw new Error('send_message not registered');
  return { tool, send, proposals, gates };
}

describe('send_message — the approval outbox gate', () => {
  it('sends exactly as today when no outbox is wired', async () => {
    const { tool, send } = harness({ outbox: false });

    const result = await tool.execute({ platform: 'telegram', target: 'C1', body: 'hi' }, ctx());

    expect(result).toEqual({ ok: true, value: 'Message sent to telegram:C1' });
    expect(send).toHaveBeenCalledWith('telegram', 'C1', 'hi', 'marketing-bot');
  });

  it('queues instead of sending, and says NOT sent', async () => {
    const { tool, send, proposals } = harness();

    const result = await tool.execute(
      { platform: 'telegram', target: '-100777', body: 'We are SOC2 certified.' },
      ctx({ origin: 'telegram:C9' }),
    );

    expect(send).not.toHaveBeenCalled();
    expect(proposals).toEqual([
      {
        personalityId: 'cmo',
        platform: 'telegram',
        target: '-100777',
        body: 'We are SOC2 certified.',
        laneBotKey: 'marketing-bot',
        sessionKey: 'telegram:marketing-bot:C9',
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('Queued for approval (obx_7f3a, revision 1). NOT sent.');
  });

  it('does not gate a send back to the turn’s own chat', async () => {
    const { tool, send, proposals } = harness();

    const result = await tool.execute(
      { platform: 'telegram', target: 'C9', body: 'on it' },
      ctx({ origin: 'telegram:C9' }),
    );

    expect(result.ok).toBe(true);
    expect(proposals).toHaveLength(0);
    expect(send).toHaveBeenCalledWith('telegram', 'C9', 'on it', 'marketing-bot');
  });

  it('does not gate a send to the operator’s own chat', async () => {
    const { tool, send, proposals } = harness({
      ownerTarget: (platform) => (platform === 'telegram' ? '4242' : undefined),
    });

    const result = await tool.execute(
      { platform: 'telegram', target: '4242', body: 'draft for you' },
      ctx({ origin: 'telegram:C9' }),
    );

    expect(result.ok).toBe(true);
    expect(proposals).toHaveLength(0);
    expect(send).toHaveBeenCalledWith('telegram', '4242', 'draft for you', 'marketing-bot');
  });

  it('does not gate a platform the policy’s channels list leaves out', async () => {
    // `channels: slack` — the policy decides, and it is asked per platform.
    const { tool, send, proposals, gates } = harness({
      gates: (_personalityId, platform) => platform === 'slack',
    });

    const result = await tool.execute(
      { platform: 'telegram', target: '-100777', body: 'ship it' },
      ctx({ origin: 'telegram:C9' }),
    );

    expect(gates).toHaveBeenCalledWith('cmo', 'telegram');
    expect(result.ok).toBe(true);
    expect(proposals).toHaveLength(0);
    expect(send).toHaveBeenCalledWith('telegram', '-100777', 'ship it', 'marketing-bot');
  });

  it('refuses a target outside the operator allowlist before it can be queued', async () => {
    const { tool, send, proposals } = harness({
      getAllowedTargets: () => ['telegram:C9'],
    });

    const result = await tool.execute(
      { platform: 'telegram', target: '-100777', body: 'ship it' },
      ctx({ origin: 'telegram:C9' }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not in the personality's allowed messaging targets");
    expect(proposals).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('surfaces a propose refusal instead of sending unqueued', async () => {
    const { tool, send } = harness({
      propose: async () => ({
        ok: false,
        error: 'ambiguous sender: 2 telegram bots speak for cmo',
      }),
    });

    const result = await tool.execute(
      { platform: 'telegram', target: '-100777', body: 'ship it' },
      ctx({ origin: 'telegram:C9' }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('ambiguous sender');
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses the send when the outbox itself throws', async () => {
    const { tool, send } = harness({
      propose: async () => {
        throw new Error('outbox.db is locked');
      },
    });

    const result = await tool.execute(
      { platform: 'telegram', target: '-100777', body: 'ship it' },
      ctx({ origin: 'telegram:C9' }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Nothing was sent');
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves a personality-less turn alone — the policy belongs to a personality', async () => {
    const { tool, send, proposals } = harness();

    const result = await tool.execute(
      { platform: 'telegram', target: '-100777', body: 'ship it' },
      ctx({ personalityId: undefined }),
    );

    expect(result.ok).toBe(true);
    expect(proposals).toHaveLength(0);
    expect(send).toHaveBeenCalled();
  });
});
