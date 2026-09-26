// The gateway systemLoop's unattended approval gate (openclaw-advisory-fixes
// Item 3). Cron, dreams, watcher wakes and SIP-inbound turns run on the
// systemLoop, which `wireApprovalFlow` never covered — so anything that needed
// approval on a bot loop ran unattended there, and the SIP far-end
// spoken-confirmation refusal `sip-inbound-dispatch.ts` promised was attached
// nowhere.
//
// Drives a real `AgentLoop`: "refused" and "not run" are separate claims, and
// only the loop settles the second.

import {
  AgentLoop,
  DefaultHookRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import { Gateway } from '@ethosagent/gateway';
import type {
  AgentSafety,
  CompletionChunk,
  DeliveryResult,
  ExecutionPosture,
  LLMProvider,
  Message,
  PersonalityConfig,
  PlatformAdapter,
  Storage,
  VoiceTurnOrigin,
} from '@ethosagent/types';
import { FAR_END_VOICE_ORIGIN, farEndRefusalReason, hasHostApprovalGate } from '@ethosagent/wiring';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalCoordinator } from '../approval-coordinator';
import { idleGatewayBot } from '../commands/gateway';
import {
  createUnattendedApprovalGate,
  noApprovalSurfaceRejection,
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
    executionPostureFor: () => undefined,
    personalities,
    getProvider: async () => {
      throw new Error('the smart reviewer must not be constructed');
    },
    model: 'mock-model',
    allowUnattendedDangerousTools: opts.allowUnattendedDangerousTools === true,
    isRemoteSenderTurn: () => false,
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

  // Command substitution is approval-required, not hardline: with nobody to
  // ask, the gate refuses it (the systemLoop's terminal guard defers to this
  // gate because `wireUnattendedApprovalGate` marks the registry).
  it('refuses command substitution — no human to approve it', async () => {
    const r = await runUnattendedTurn({
      toolName: 'terminal',
      args: { command: 'kill $(lsof -t -i:3000)' },
    });
    expect(r.ran).toBe(false);
    expect(r.toolEndErrors).toEqual([
      unattendedApprovalRejection(
        'terminal',
        'terminal requires explicit approval (command substitution)',
      ),
    ]);
    expect(r.coordinatorCalls).toBe(0);
  });

  // The D12 opt-in pre-authorizes flagged TOOLS, not a command whose real
  // payload is hidden in a substitution: the predicate never auto-approves
  // one (`createDangerPredicate`), so with nobody to ask it is refused.
  it('approvalMode off + allowUnattendedDangerousTools still refuses command substitution', async () => {
    const r = await runUnattendedTurn({
      toolName: 'terminal',
      args: { command: 'kill $(lsof -t -i:3000)' },
      safety: { approvalMode: 'off' },
      allowUnattendedDangerousTools: true,
    });
    expect(r.ran).toBe(false);
    expect(r.toolEndErrors).toEqual([
      unattendedApprovalRejection(
        'terminal',
        'terminal requires explicit approval (command substitution)',
      ),
    ]);

    // Other flagged calls under the same settings are still auto-approved.
    const flagged = await runUnattendedTurn({
      toolName: 'call',
      safety: { approvalMode: 'off' },
      allowUnattendedDangerousTools: true,
    });
    expect(flagged.ran).toBe(true);
    const plainShell = await runUnattendedTurn({
      toolName: 'terminal',
      args: { command: 'ls -la' },
      safety: { approvalMode: 'off' },
      allowUnattendedDangerousTools: true,
    });
    expect(plainShell.ran).toBe(true);
  });

  it('marks the registry as carrying a host approval gate', () => {
    const hooks = new DefaultHookRegistry();
    expect(hasHostApprovalGate(hooks)).toBe(false);
    wireUnattendedApprovalGate(hooks, {
      executionPostureFor: () => undefined,
      personalities: new DefaultPersonalityRegistry(),
      getProvider: async () => {
        throw new Error('unused');
      },
      model: 'mock-model',
      allowUnattendedDangerousTools: false,
      isRemoteSenderTurn: () => false,
    });
    expect(hasHostApprovalGate(hooks)).toBe(true);
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

// The idle gateway (no bot configured): the systemLoop is also the idle bot's
// loop, so plugin channel turns from remote senders run on it beside cron.
// `runGatewayStart` wires `isRemoteSenderTurn` to the route `Gateway.runTurn`
// sets for its own channel turns; this drives exactly that through a real
// `Gateway` and a real `AgentLoop`.
function idleGatewayRig(opts: {
  safety?: PersonalityConfig['safety'];
  allowUnattendedDangerousTools: boolean;
}) {
  const ran: string[] = [];
  const toolErrors: string[] = [];
  const tools = new DefaultToolRegistry();
  tools.register({
    name: 'call',
    description: 'a flagged tool',
    schema: { type: 'object' },
    capabilities: {},
    async execute() {
      ran.push('call');
      return { ok: true as const, value: 'did the thing' };
    },
  });
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({
    id: 'idlebot',
    name: 'Idle Bot',
    ...(opts.safety ? { safety: opts.safety } : {}),
  });
  // Stateless: asks for `call` until the history carries its result, and
  // records a refused result's text.
  const llm: LLMProvider = {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
      const last = messages[messages.length - 1];
      const results = Array.isArray(last?.content)
        ? last.content.filter((b) => b.type === 'tool_result')
        : [];
      if (results.length === 0) {
        yield { type: 'tool_use_start', toolCallId: 't1', toolName: 'call' };
        yield { type: 'tool_use_end', toolCallId: 't1', inputJson: '{}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      for (const r of results) if (r.is_error) toolErrors.push(r.content);
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
  const loop = new AgentLoop({ llm, safety: gatedSafety(), tools, personalities });
  const gateway = new Gateway({ bots: [idleGatewayBot(loop, 'idlebot', undefined)] });
  // Exactly what `runGatewayStart` registers on the systemLoop.
  wireUnattendedApprovalGate(loop.hooks, {
    executionPostureFor: () => undefined,
    personalities,
    getProvider: async () => {
      throw new Error('the smart reviewer must not be constructed');
    },
    model: 'mock-model',
    allowUnattendedDangerousTools: opts.allowUnattendedDangerousTools,
    isRemoteSenderTurn: (sessionId) => gateway.resolveApprovalRoute(sessionId) !== undefined,
  });
  const adapter: PlatformAdapter = {
    id: 'fakechan/chan',
    displayName: 'Fake channel',
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 100_000,
    async start() {},
    async stop() {},
    async send(): Promise<DeliveryResult> {
      return { ok: true, messageId: 'm1' };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
  };
  const channelTurn = () =>
    gateway.handleMessage(
      {
        platform: 'fakechan/chan',
        chatId: 'remote-chat',
        userId: 'stranger',
        text: 'please place a call',
        isDm: true,
        isGroupMention: false,
        raw: null,
      },
      adapter,
    );
  const cronTurn = async () => {
    for await (const _ of loop.run('scheduled job', {
      sessionKey: 'cron:job:nightly',
      personalityId: 'idlebot',
    })) {
      // drain
    }
  };
  return { ran, toolErrors, channelTurn, cronTurn };
}

describe('idle gateway — channel turns on the systemLoop never get the D12 opt-in', () => {
  const offWithKey = {
    safety: { approvalMode: 'off' as const },
    allowUnattendedDangerousTools: true,
  };

  it('a channel turn with approvalMode off + the key is refused with the no-surface text', async () => {
    const rig = idleGatewayRig(offWithKey);
    await rig.channelTurn();
    expect(rig.ran).toEqual([]);
    expect(rig.toolErrors).toEqual([
      noApprovalSurfaceRejection('call', 'call requires explicit approval'),
    ]);
  });

  it('a cron job on the same loop with off + the key keeps the opt-in', async () => {
    const rig = idleGatewayRig(offWithKey);
    await rig.cronTurn();
    expect(rig.ran).toEqual(['call']);
    expect(rig.toolErrors).toEqual([]);
  });

  it('a channel turn without the opt-in is refused too', async () => {
    const rig = idleGatewayRig({ allowUnattendedDangerousTools: false });
    await rig.channelTurn();
    expect(rig.ran).toEqual([]);
    expect(rig.toolErrors).toEqual([
      noApprovalSurfaceRejection('call', 'call requires explicit approval'),
    ]);
  });

  it('a throwing origin test fails closed (refused, no-surface text)', async () => {
    const personalities = new DefaultPersonalityRegistry();
    personalities.define({ id: 'p', name: 'P', safety: { approvalMode: 'off' } });
    const handlers: Array<(p: unknown) => Promise<unknown>> = [];
    const hooks = {
      registerModifying: (_n: string, h: never) => {
        handlers.push(h);
        return () => {};
      },
      registerVoid: () => () => {},
    } as unknown as Parameters<typeof wireUnattendedApprovalGate>[0];
    wireUnattendedApprovalGate(hooks, {
      executionPostureFor: () => undefined,
      personalities,
      getProvider: async () => {
        throw new Error('unused');
      },
      model: 'm',
      allowUnattendedDangerousTools: true,
      isRemoteSenderTurn: () => {
        throw new Error('origin unknown');
      },
    });
    const [handler] = handlers;
    expect(
      await handler?.({ sessionId: 's', toolCallId: 't', toolName: 'call', args: {} }),
    ).toEqual({ error: noApprovalSurfaceRejection('call', 'call requires explicit approval') });
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

  // S6 / D1(a): under a host-local posture the shell tools are flagged too,
  // so a cron job that reaches them is refused unattended — report it.
  it('adds the local-posture shell tools for a host-local personality', () => {
    const local = {
      id: 'localShell',
      name: 'l',
      toolset: ['terminal', 'read_file'],
    } as PersonalityConfig;
    expect(
      unattendedCronExposure({
        jobs: [{ personalityId: 'localShell', prompt: 'p' }],
        getPersonality: () => local,
        allowUnattendedDangerousTools: false,
        executionPostureFor: () => ({ backend: 'local', containerized: false }) as ExecutionPosture,
      }),
    ).toEqual([{ personalityId: 'localShell', tools: ['terminal'] }]);
    expect(
      unattendedCronExposure({
        jobs: [{ personalityId: 'localShell', prompt: 'p' }],
        getPersonality: () => local,
        allowUnattendedDangerousTools: false,
        executionPostureFor: () =>
          ({ backend: 'docker', containerized: false }) as ExecutionPosture,
      }),
    ).toEqual([]);
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
