// `ethos cron run` / `ethos cron daemon` run jobs unattended, like the
// gateway's cron/dream loop, so they take the gateway's rule for
// `approvalMode: off`: a flagged call is auto-approved only when the operator
// also set `allowUnattendedDangerousTools: true` (`gateCronLoop`,
// apps/ethos/src/lib/non-interactive-approval.ts, which reuses
// `wireUnattendedApprovalGate`). Operator-invoked commands (`ethos chat`, `-z`,
// `batch`, `eval`) keep honouring `off` on its own.

import type { EthosConfig } from '@ethosagent/config';
import { DefaultHookRegistry } from '@ethosagent/core';
import type {
  BeforeToolCallResult,
  ExecutionPosture,
  PersonalityConfig,
  PersonalityRegistry,
} from '@ethosagent/types';
import { hasHostApprovalGate } from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import { type GatableLoop, gateCronLoop } from '../lib/non-interactive-approval';

const off = { id: 'p1', safety: { approvalMode: 'off' } } as PersonalityConfig;

async function cronCall(allowUnattendedDangerousTools: boolean) {
  const hooks = new DefaultHookRegistry();
  const runtime = {
    loop: { hooks },
    personalities: { get: () => off } as unknown as PersonalityRegistry,
    executionPostureFor: () => ({ backend: 'local' }) as ExecutionPosture,
  } as unknown as GatableLoop;
  gateCronLoop(runtime, {
    model: 'test-model',
    allowUnattendedDangerousTools,
  } as EthosConfig);
  // `session_start` teaches the predicate which personality the turn runs.
  await hooks.fireVoid('session_start', { sessionId: 'cron-1', personalityId: 'p1' } as never);
  const result: Partial<BeforeToolCallResult> = await hooks.fireModifying('before_tool_call', {
    sessionId: 'cron-1',
    toolCallId: 'tc-1',
    toolName: 'terminal',
    args: { command: 'ls -la' },
    personalityId: 'p1',
  });
  return { hooks, result };
}

describe('ethos cron — approvalMode off needs the unattended opt-in', () => {
  it('off without allowUnattendedDangerousTools refuses a flagged call', async () => {
    const { hooks, result } = await cronCall(false);
    expect(hasHostApprovalGate(hooks)).toBe(true);
    expect(result.error).toMatch(/no human is present to approve terminal/);
  });

  it('off with allowUnattendedDangerousTools runs it', async () => {
    const { result } = await cronCall(true);
    expect(result.error).toBeUndefined();
  });
});
