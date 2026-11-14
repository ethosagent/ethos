// Deny-and-redirect, end to end: a note typed on a deny reaches the model as
// the blocked call's tool_result. Real AgentLoop + ApprovalCoordinator + hook.
// Pins the framing from `formatApprovalDenial` (surface-kit) via the
// `before_tool_call` hook in `../approval-coordinator`.

import {
  AgentLoop,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
} from '@ethosagent/core';
import { collect, scriptedLLM } from '@ethosagent/test-kit';
import { describe, expect, it, vi } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { ApprovalCoordinator, createSlackApprovalHook } from '../approval-coordinator';

describe('deny-and-redirect', () => {
  it("the model reads the note as the blocked call's tool_result", async () => {
    const execute = vi.fn(async () => ({ ok: true as const, value: 'ran' }));
    const tools = new DefaultToolRegistry();
    tools.register({
      name: 'terminal',
      description: 'run a command',
      schema: { type: 'object' },
      capabilities: {},
      execute,
    });
    const personalities = new DefaultPersonalityRegistry();
    personalities.define({ id: 'default', name: 'Default', toolset: ['terminal'] });
    const llm = scriptedLLM([
      [{ id: 'tc1', name: 'terminal', input: { command: 'rm -rf /' } }],
      'ok',
    ]);
    const loop = new AgentLoop({
      llm,
      tools,
      session: new InMemorySessionStore(),
      personalities,
      safety: createTestSafety(),
      compaction: { autoCompact: false },
    });
    const coordinator = new ApprovalCoordinator();
    coordinator.onPending(
      (p) => void coordinator.deny(p.approvalId, 'U1', 'use the staging DB instead'),
    );
    loop.hooks.registerModifying(
      'before_tool_call',
      createSlackApprovalHook({
        coordinator,
        isDangerous: async () => 'recursive delete',
        hardlineReason: () => null,
        resolveApprovalTarget: () => ({ requesterUserId: 'U1' }),
        withoutSurface: async () => ({}),
      }),
    );

    await collect(loop.run('clean up', { roomAudience: 'private' }));

    expect(execute).not.toHaveBeenCalled();
    const blocks = llm.calls[1].messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content : [],
    );
    const result = blocks.find((b) => b.type === 'tool_result' && b.tool_use_id === 'tc1');
    expect(result).toMatchObject({ type: 'tool_result', is_error: true });
    expect(JSON.stringify(result)).toContain('said what to do instead: use the staging DB instead');
  });
});
