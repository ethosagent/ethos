// The gateway systemLoop's unattended approval gate (openclaw-advisory-fixes
// Item 3). Cron, dreams, watcher wakes and SIP-inbound turns run on the
// systemLoop, which `wireApprovalFlow` never covered — so anything that needed
// approval on a bot loop ran unattended there, and the SIP far-end
// spoken-confirmation refusal `sip-inbound-dispatch.ts` promised was attached
// nowhere.
//
// Drives a real `AgentLoop`: "refused" and "not run" are separate claims, and
// only the loop settles the second.

import { AgentLoop, DefaultPersonalityRegistry, DefaultToolRegistry } from '@ethosagent/core';
import type {
  AgentSafety,
  CompletionChunk,
  LLMProvider,
  PersonalityConfig,
  Storage,
  VoiceTurnOrigin,
} from '@ethosagent/types';
import { FAR_END_VOICE_ORIGIN, farEndRefusalReason } from '@ethosagent/wiring';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalCoordinator } from '../approval-coordinator';
import {
  createUnattendedApprovalGate,
  reportUnattendedCronExposure,
  UNATTENDED_CRON_EXPOSURE_CODE,
  unattendedApprovalRejection,
  unattendedCronExposure,
  wireUnattendedApprovalGate,
} from '../unattended-approval-gate';

function gatedSafety(): AgentSafety {
  return {
    injection: {
      prelude: '',
      downgradeRejectionMessage: 'refused',
      sanitize: (content) => content,
      wrapUntrusted: (input) => ({ content: input.content, strippedTokens: 0 }),
      shortPatternCheck: () => ({ containsInstructions: false, hits: [] }),
      c2PatternCheck: () => ({ containsInstructions: false }),
      resolveDowngradedTools: () => new Set<string>(),
    },
    redaction: {
      redactPii: (text) => text,
      redactString: (text) => text,
      detectSecrets: () => [],
    },
    scopedStorageFactory: (base: Storage) => base,
    approvalPosture: { kind: 'gated', policy: 'danger-predicate' },
  };
}

function llmCalling(toolName: string, args: unknown): LLMProvider {
  let round = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      round += 1;
      if (round === 1) {
        yield { type: 'tool_use_start', toolCallId: 't1', toolName };
        yield { type: 'tool_use_end', toolCallId: 't1', inputJson: JSON.stringify(args) };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
}

async function runUnattendedTurn(opts: {
  toolName: string;
  args?: unknown;
  safety?: PersonalityConfig['safety'];
  allowUnattendedDangerousTools?: boolean;
  voiceOrigin?: VoiceTurnOrigin;
}): Promise<{ ran: boolean; toolEndErrors: string[]; coordinatorCalls: number }> {
  let ran = false;
  const tools = new DefaultToolRegistry();
  tools.register({
    name: opts.toolName,
    description: 'a flagged tool',
    schema: { type: 'object' },
    capabilities: {},
    async execute() {
      ran = true;
      return { ok: true as const, value: 'did the thing' };
    },
  });
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({
    id: 'cronbot',
    name: 'Cron Bot',
    ...(opts.safety ? { safety: opts.safety } : {}),
  });
  const loop = new AgentLoop({
    llm: llmCalling(opts.toolName, opts.args ?? {}),
    safety: gatedSafety(),
    tools,
    personalities,
  });
  // A coordinator exists in the process (the bot loops' card flow); the
  // unattended gate must never route a systemLoop call into it.
  const coordinator = new ApprovalCoordinator();
  const requestApproval = vi.spyOn(coordinator, 'requestApproval');

  // Exactly what `runGatewayStart` registers on the systemLoop.
  wireUnattendedApprovalGate(loop.hooks, {
    personalities,
    getProvider: async () => {
      throw new Error('the smart reviewer must not be constructed');
    },
    model: 'mock-model',
    allowUnattendedDangerousTools: opts.allowUnattendedDangerousTools === true,
  });

  const toolEndErrors: string[] = [];
  for await (const event of loop.run('scheduled job', {
    sessionKey: `cron:job:${Math.random()}`,
    personalityId: 'cronbot',
    ...(opts.voiceOrigin ? { voiceOrigin: opts.voiceOrigin } : {}),
  })) {
    if (event.type === 'tool_end' && event.error) toolEndErrors.push(event.error);
  }
  return { ran, toolEndErrors, coordinatorCalls: requestApproval.mock.calls.length };
}

describe('systemLoop unattended approval gate', () => {
  it('(a) refuses a flagged tool with the unattended reason, never asking a coordinator', async () => {
    const r = await runUnattendedTurn({ toolName: 'call' });
    expect(r.ran).toBe(false);
    expect(r.toolEndErrors).toEqual([
      unattendedApprovalRejection('call', 'call requires explicit approval'),
    ]);
    expect(r.toolEndErrors[0]).toContain('no human is present to approve call');
    expect(r.coordinatorCalls).toBe(0);
  });

  it('(b) refuses a far-end caller’s consequential request (spoken-confirmation gate)', async () => {
    // Even under the loosest configuration: a caller's voice cannot authorize.
    const r = await runUnattendedTurn({
      toolName: 'write_file',
      args: { path: 'notes.md', content: 'x' },
      safety: { approvalMode: 'off' },
      allowUnattendedDangerousTools: true,
      voiceOrigin: FAR_END_VOICE_ORIGIN,
    });
    expect(r.ran).toBe(false);
    expect(r.toolEndErrors).toEqual([
      unattendedApprovalRejection('write_file', farEndRefusalReason('write_file')),
    ]);
  });

  it('(c) approvalMode off + allowUnattendedDangerousTools passes; without the key it refuses', async () => {
    const allowed = await runUnattendedTurn({
      toolName: 'call',
      safety: { approvalMode: 'off' },
      allowUnattendedDangerousTools: true,
    });
    expect(allowed.ran).toBe(true);
    expect(allowed.toolEndErrors).toEqual([]);

    const refused = await runUnattendedTurn({
      toolName: 'call',
      safety: { approvalMode: 'off' },
    });
    expect(refused.ran).toBe(false);
    expect(refused.toolEndErrors[0]).toContain('no human is present to approve call');
  });

  it('(d) a deny-rule match refuses even with the pre-authorized settings', async () => {
    const r = await runUnattendedTurn({
      toolName: 'call',
      args: { to: '+15550100' },
      safety: { approvalMode: 'off', denyRules: ['+15550100'] },
      allowUnattendedDangerousTools: true,
    });
    expect(r.ran).toBe(false);
    expect(r.toolEndErrors).toEqual(['denied by personality deny rule: +15550100']);
  });

  it('lets an unflagged tool through — the gate refuses danger, not everything', async () => {
    const r = await runUnattendedTurn({ toolName: 'read_file' });
    expect(r.ran).toBe(true);
    expect(r.toolEndErrors).toEqual([]);
  });

  it('createUnattendedApprovalGate renders the caller’s rejection text', async () => {
    const gate = createUnattendedApprovalGate(
      async (p) => (p.toolName === 'x' ? 'x is risky' : null),
      (tool, reason) => `nope: ${tool} / ${reason}`,
    );
    const base = { sessionId: 's', toolCallId: 't', args: {} };
    expect(await gate({ ...base, toolName: 'x' })).toEqual({ error: 'nope: x / x is risky' });
    expect(await gate({ ...base, toolName: 'y' })).toEqual({});
  });
});

describe('boot-time cron exposure report', () => {
  const personas: Record<string, PersonalityConfig> = {
    manualWithCall: { id: 'manualWithCall', name: 'm', toolset: ['call', 'read_file', 'cron'] },
    manualReadOnly: { id: 'manualReadOnly', name: 'r', toolset: ['read_file'] },
    smartWriter: {
      id: 'smartWriter',
      name: 's',
      toolset: ['write_file', 'read_file'],
      safety: { approvalMode: 'smart' },
    },
    offUnrestricted: { id: 'offUnrestricted', name: 'o', safety: { approvalMode: 'off' } },
  };
  const jobs = [
    { personalityId: 'manualWithCall', prompt: 'p' },
    { personalityId: 'manualReadOnly', prompt: 'p' },
    { personalityId: 'smartWriter', prompt: 'p' },
    { personalityId: 'offUnrestricted', prompt: 'p' },
    // No LLM turn: never exposed.
    { personalityId: 'scriptOnly' },
    { personalityId: 'systemJob', prompt: 'p', source: 'system' as const },
  ];

  it('lists personalities whose cron toolset intersects the flagged set', () => {
    expect(
      unattendedCronExposure({
        jobs,
        getPersonality: (id) => personas[id],
        allowUnattendedDangerousTools: false,
      }),
    ).toEqual([
      { personalityId: 'manualWithCall', tools: ['call'] },
      {
        personalityId: 'offUnrestricted',
        tools: ['call', 'skills_pending_approve', 'skills_pending_reject'],
      },
      { personalityId: 'smartWriter', tools: ['write_file'] },
    ]);
  });

  it('drops approvalMode off personalities once the operator pre-authorizes', () => {
    const ids = unattendedCronExposure({
      jobs,
      getPersonality: (id) => personas[id],
      allowUnattendedDangerousTools: true,
    }).map((e) => e.personalityId);
    expect(ids).not.toContain('offUnrestricted');
  });

  it('records ONE warn-level safety event naming every exposed personality', () => {
    const recordSafetyBlock = vi.fn();
    reportUnattendedCronExposure({
      jobs,
      getPersonality: (id) => personas[id],
      allowUnattendedDangerousTools: false,
      recordSafetyBlock,
    });
    expect(recordSafetyBlock).toHaveBeenCalledTimes(1);
    const event = recordSafetyBlock.mock.calls[0]?.[0];
    expect(event.code).toBe(UNATTENDED_CRON_EXPOSURE_CODE);
    expect(event.cause).toContain('manualWithCall (call)');
    expect(event.cause).toContain('smartWriter (write_file)');
  });

  it('records nothing when nothing is exposed, and survives a throwing sink', () => {
    const quiet = vi.fn();
    reportUnattendedCronExposure({
      jobs: [{ personalityId: 'manualReadOnly', prompt: 'p' }],
      getPersonality: (id) => personas[id],
      allowUnattendedDangerousTools: false,
      recordSafetyBlock: quiet,
    });
    expect(quiet).not.toHaveBeenCalled();

    expect(() =>
      reportUnattendedCronExposure({
        jobs,
        getPersonality: (id) => personas[id],
        allowUnattendedDangerousTools: false,
        recordSafetyBlock: () => {
          throw new Error('observability down');
        },
      }),
    ).not.toThrow();
  });
});
