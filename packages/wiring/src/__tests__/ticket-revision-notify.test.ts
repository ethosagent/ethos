/**
 * N4 (ux-feedback-and-config-clarity) — the default `after_ticket_revision`
 * handler notifies a human channel with the revision reason.
 *
 * The payload carries no origin channel and the kanban Task row stores none
 * (see the limitation note on `registerTicketRevisionNotifier`), so the
 * handler targets the assignee personality's first channel-shaped messaging
 * allowlist entry — the same `platform:chatId` entries `send_message` may
 * deliver to. No entry → no notice; a failed send never propagates (Void
 * hook, fail-open).
 */

import { DefaultHookRegistry } from '@ethosagent/core';
import type { AfterTicketRevisionPayload } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { registerTicketRevisionNotifier } from '../compose-tools';

const PAYLOAD: AfterTicketRevisionPayload = {
  taskId: 'task-1234567890abcdef',
  summary: 'implemented the thing',
  reason: 'acceptance criteria unmet: no test added',
  assignee: 'engineer',
};

function setup(targets: Record<string, string[]>) {
  const hooks = new DefaultHookRegistry();
  const send = vi.fn(async () => ({ ok: true }));
  registerTicketRevisionNotifier({
    hooks,
    send,
    getAllowedTargets: (id) => (id ? (targets[id] ?? []) : []),
  });
  return { hooks, send };
}

describe('registerTicketRevisionNotifier', () => {
  it("sends the revision reason to the assignee's first channel-shaped target", async () => {
    const { hooks, send } = setup({ engineer: ['telegram:12345'] });
    await hooks.fireVoid('after_ticket_revision', PAYLOAD);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'telegram',
      '12345',
      'Ticket task-123 needs revision — acceptance criteria unmet: no test added',
    );
  });

  it("skips non-channel entries ('*', cli, web) and uses the first platform:chatId one", async () => {
    const { hooks, send } = setup({ engineer: ['*', 'cli', 'web', 'slack:C042'] });
    await hooks.fireVoid('after_ticket_revision', PAYLOAD);
    expect(send).toHaveBeenCalledWith('slack', 'C042', expect.stringContaining('needs revision'));
  });

  it('sends nothing when the assignee has no channel-shaped target', async () => {
    const { hooks, send } = setup({ engineer: ['*'], reviewer: ['telegram:999'] });
    await hooks.fireVoid('after_ticket_revision', PAYLOAD);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing for an assignee with no allowlist at all', async () => {
    const { hooks, send } = setup({});
    await hooks.fireVoid('after_ticket_revision', PAYLOAD);
    expect(send).not.toHaveBeenCalled();
  });

  it('a failed send never propagates out of the hook (fail-open)', async () => {
    const hooks = new DefaultHookRegistry();
    const send = vi.fn(async () => {
      throw new Error('Gateway not active');
    });
    registerTicketRevisionNotifier({ hooks, send, getAllowedTargets: () => ['telegram:1'] });
    await expect(hooks.fireVoid('after_ticket_revision', PAYLOAD)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalled();
  });
});
