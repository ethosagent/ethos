import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentLoop,
  DefaultHookRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import type {
  AgentEvent,
  BeforeToolCallPayload,
  CompletionChunk,
  ExecutionPosture,
  LLMProvider,
  Message,
  PersonalityConfig,
} from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestSafety } from '../../../core/src/__tests__/helpers/test-safety';
import {
  createApprovalDangerPredicate,
  createLazyProvider,
  REWRITTEN_ARGS_NOTE,
} from '../approval-seams';
import { createSmartApprover } from '../smart-approver';

// The reviewer must not even be CONSTRUCTED on the default path — a
// deployment where no personality declares `smart` pays nothing. Spying on the
// factory is the only way to assert that from outside.
vi.mock('../smart-approver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../smart-approver')>();
  return { ...actual, createSmartApprover: vi.fn(actual.createSmartApprover) };
});

function payload(toolName: string, args: unknown, sessionId = 'sess-1'): BeforeToolCallPayload {
  return { sessionId, toolCallId: 'tc-1', toolName, args };
}

function person(id: string, safety?: PersonalityConfig['safety']): PersonalityConfig {
  return { id, name: id, ...(safety ? { safety } : {}) };
}

function registryWith(...configs: PersonalityConfig[]): DefaultPersonalityRegistry {
  const registry = new DefaultPersonalityRegistry();
  for (const config of configs) registry.define(config);
  return registry;
}

/** Provider that answers every review with the same verdict JSON. */
function verdictProvider(json: string): { provider: LLMProvider; calls: () => number } {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'stub',
    model: 'stub-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(_messages: Message[]): AsyncIterable<CompletionChunk> {
      calls++;
      yield { type: 'text_delta', text: json };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
  return { provider, calls: () => calls };
}

/** LLM that calls `toolName` once, then ends the turn with text. */
function toolCallingLLM(toolName: string, args: unknown): LLMProvider {
  let round = 0;
  return {
    name: 'tool-caller',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      round++;
      if (round > 1) {
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      const inputJson = JSON.stringify(args);
      yield { type: 'tool_use_start', toolCallId: 'call-1', toolName };
      yield { type: 'tool_use_delta', toolCallId: 'call-1', partialJson: inputJson };
      yield { type: 'tool_use_end', toolCallId: 'call-1', inputJson };
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

beforeEach(() => {
  vi.mocked(createSmartApprover).mockClear();
});

describe('createLazyProvider', () => {
  it('constructs at most once and only on demand', async () => {
    let constructed = 0;
    const { provider } = verdictProvider('{}');
    const get = createLazyProvider(async () => {
      constructed++;
      return provider;
    });

    expect(constructed).toBe(0);
    expect(await get()).toBe(provider);
    expect(await get()).toBe(provider);
    expect(constructed).toBe(1);
  });

  it('does not cache a failed construction', async () => {
    let attempts = 0;
    const { provider } = verdictProvider('{}');
    const get = createLazyProvider(async () => {
      attempts++;
      if (attempts === 1) throw new Error('no api key');
      return provider;
    });

    await expect(get()).rejects.toThrow('no api key');
    expect(await get()).toBe(provider);
    expect(attempts).toBe(2);
  });
});

// Resolution is observed through `approvalMode: 'smart'`: a resolved session
// reaches the reviewer (which approves → null), an unresolved one falls back to
// the `manual` default (the flagged reason). Deny rules are no longer this
// predicate's concern — core refuses them before any hook runs
// (packages/core/src/agent-loop/__tests__/deny-rule-gate.test.ts).
// S6 / D1(a): the posture comes from the SAME personality the session resolved,
// via the host-supplied `executionPostureFor`.
describe('createApprovalDangerPredicate — execution posture', () => {
  it('asks before terminal when the session personality runs on a host-local posture', async () => {
    const hooks = new DefaultHookRegistry();
    const asked: Array<string | undefined> = [];
    const isDangerous = createApprovalDangerPredicate({
      hooks: [hooks],
      personalities: registryWith(person('local-one', {}), person('boxed', {})),
      getProvider: async () => {
        throw new Error('provider must not be constructed');
      },
      model: 'm',
      executionPostureFor: (id) => {
        asked.push(id);
        return {
          backend: id === 'local-one' ? 'local' : 'docker',
          containerized: false,
        } as ExecutionPosture;
      },
    });
    await hooks.fireVoid('session_start', {
      sessionId: 's-local',
      sessionKey: 'k1',
      platform: 'web',
      personalityId: 'local-one',
    });
    await hooks.fireVoid('session_start', {
      sessionId: 's-boxed',
      sessionKey: 'k2',
      platform: 'web',
      personalityId: 'boxed',
    });
    expect(await isDangerous(payload('terminal', { command: 'ls' }, 's-local'))).toBe(
      'terminal requires explicit approval',
    );
    expect(await isDangerous(payload('terminal', { command: 'ls' }, 's-boxed'))).toBeNull();
    expect(asked).toEqual(['local-one', 'boxed']);
  });
});

// S10 follow-up: when a `before_tool_call` handler rewrites the args, core
// fires the hook again on the rewritten args (`enforceBeforeToolCall`) with
// `rewrittenFrom` set, and an approval surface is asked a second time. That
// second prompt must say why it is being asked again.
describe('createApprovalDangerPredicate — re-judge of rewritten args', () => {
  function manual() {
    return createApprovalDangerPredicate({
      executionPostureFor: () => undefined,
      hooks: [new DefaultHookRegistry()],
      personalities: registryWith(),
      getProvider: async () => {
        throw new Error('provider must not be constructed');
      },
      model: 'm',
      alwaysAsk: ['shell'],
    });
  }

  it('says the arguments were rewritten on the re-judge fire', async () => {
    const reason = await manual()({
      ...payload('shell', { command: 'cd /repo && ls' }),
      rewrittenFrom: { command: 'ls' },
    });
    expect(reason).toBe(`shell requires explicit approval${REWRITTEN_ARGS_NOTE}`);
    expect(reason).toContain('rewrote the arguments');
  });

  it('leaves the first fire’s reason unchanged', async () => {
    expect(await manual()(payload('shell', { command: 'ls' }))).toBe(
      'shell requires explicit approval',
    );
  });

  it('stays null for a rewritten call nothing flags', async () => {
    expect(
      await manual()({ ...payload('read_file', { path: 'b' }), rewrittenFrom: { path: 'a' } }),
    ).toBeNull();
  });
});

describe('createApprovalDangerPredicate — personality resolution', () => {
  it('resolves the turn personality from session_start', async () => {
    const hooks = new DefaultHookRegistry();
    const { provider, calls } = verdictProvider('{"decision":"approve","reason":"fine"}');
    const isDangerous = createApprovalDangerPredicate({
      executionPostureFor: () => undefined,
      hooks: [hooks],
      personalities: registryWith(person('reviewed', { approvalMode: 'smart' })),
      getProvider: async () => provider,
      model: 'reviewer-model',
      alwaysAsk: ['shell'],
    });

    await hooks.fireVoid('session_start', {
      sessionId: 'sess-1',
      sessionKey: 'k',
      platform: 'web',
      personalityId: 'reviewed',
    });

    expect(await isDangerous(payload('shell', { command: 'ls' }))).toBeNull();
    expect(calls()).toBe(1);
  });

  it('falls back to manual for a session it never saw', async () => {
    const hooks = new DefaultHookRegistry();
    const isDangerous = createApprovalDangerPredicate({
      executionPostureFor: () => undefined,
      hooks: [hooks],
      personalities: registryWith(person('reviewed', { approvalMode: 'smart' })),
      getProvider: async () => {
        throw new Error('provider must not be constructed');
      },
      model: 'reviewer-model',
      alwaysAsk: ['shell'],
    });

    // No `session_start` fired — an unresolved session must never pick up
    // another personality's policy.
    expect(await isDangerous(payload('shell', { command: 'ls' }, 'unknown'))).toBe(
      'shell requires explicit approval',
    );
    expect(vi.mocked(createSmartApprover)).not.toHaveBeenCalled();
  });

  it('forgets the session personality once the turn ends', async () => {
    const hooks = new DefaultHookRegistry();
    const { provider } = verdictProvider('{"decision":"approve","reason":"fine"}');
    const isDangerous = createApprovalDangerPredicate({
      executionPostureFor: () => undefined,
      hooks: [hooks],
      personalities: registryWith(person('reviewed', { approvalMode: 'smart' })),
      getProvider: async () => provider,
      model: 'reviewer-model',
      alwaysAsk: ['shell'],
    });

    await hooks.fireVoid('session_start', {
      sessionId: 'sess-1',
      sessionKey: 'k',
      platform: 'web',
      personalityId: 'reviewed',
    });
    expect(await isDangerous(payload('shell', { command: 'ls' }))).toBeNull();

    await hooks.fireVoid('agent_done', { sessionId: 'sess-1', text: '', turnCount: 1 });
    expect(await isDangerous(payload('shell', { command: 'ls' }))).toBe(
      'shell requires explicit approval',
    );
  });
});

describe('createApprovalDangerPredicate — smart mode', () => {
  it('routes a flagged call to the LLM reviewer', async () => {
    const hooks = new DefaultHookRegistry();
    const { provider, calls } = verdictProvider(
      '{"decision":"deny","reason":"sends mail to strangers"}',
    );
    let constructed = 0;
    const isDangerous = createApprovalDangerPredicate({
      executionPostureFor: () => undefined,
      hooks: [hooks],
      personalities: registryWith(person('reviewed', { approvalMode: 'smart' })),
      getProvider: createLazyProvider(async () => {
        constructed++;
        return provider;
      }),
      model: 'reviewer-model',
      alwaysAsk: ['email_send'],
    });

    await hooks.fireVoid('session_start', {
      sessionId: 'sess-1',
      sessionKey: 'k',
      platform: 'slack',
      personalityId: 'reviewed',
    });

    const reason = await isDangerous(payload('email_send', { to: 'a@b' }));

    expect(reason).toBe('denied by reviewer: sends mail to strangers');
    expect(calls()).toBe(1);
    expect(constructed).toBe(1);
    expect(vi.mocked(createSmartApprover)).toHaveBeenCalledTimes(1);
  });

  it('never constructs the reviewer or the provider when no personality declares smart', async () => {
    const hooks = new DefaultHookRegistry();
    let constructed = 0;
    const isDangerous = createApprovalDangerPredicate({
      executionPostureFor: () => undefined,
      hooks: [hooks],
      personalities: registryWith(person('plain'), person('explicit', { approvalMode: 'manual' })),
      getProvider: createLazyProvider(async () => {
        constructed++;
        throw new Error('provider must not be constructed');
      }),
      model: 'reviewer-model',
      alwaysAsk: ['email_send'],
    });

    for (const personalityId of ['plain', 'explicit']) {
      await hooks.fireVoid('session_start', {
        sessionId: personalityId,
        sessionKey: personalityId,
        platform: 'web',
        personalityId,
      });
      expect(await isDangerous(payload('email_send', { to: 'a@b' }, personalityId))).toBe(
        'email_send requires explicit approval',
      );
      expect(await isDangerous(payload('read_file', { path: 'x' }, personalityId))).toBeNull();
    }

    expect(constructed).toBe(0);
    expect(vi.mocked(createSmartApprover)).not.toHaveBeenCalled();
  });
});

describe('createApprovalDangerPredicate — built-in consequential flag set', () => {
  /** Wire a predicate for `personalityId` and report provider construction. */
  function smartPredicate(safety: PersonalityConfig['safety'], verdictJson: string) {
    const hooks = new DefaultHookRegistry();
    const { provider, calls } = verdictProvider(verdictJson);
    let constructed = 0;
    const isDangerous = createApprovalDangerPredicate({
      executionPostureFor: () => undefined,
      hooks: [hooks],
      personalities: registryWith(person('p', safety)),
      getProvider: createLazyProvider(async () => {
        constructed++;
        return provider;
      }),
      model: 'reviewer-model',
    });
    const started = hooks.fireVoid('session_start', {
      sessionId: 'sess-1',
      sessionKey: 'k',
      platform: 'web',
      personalityId: 'p',
    });
    return { isDangerous, started, calls, constructed: () => constructed };
  }

  it('does not construct the provider for a read-only tool under smart', async () => {
    const seam = smartPredicate({ approvalMode: 'smart' }, '{"decision":"deny","reason":"no"}');
    await seam.started;

    expect(await seam.isDangerous(payload('read_file', { path: 'notes.md' }))).toBeNull();
    expect(await seam.isDangerous(payload('search_files', { query: 'todo' }))).toBeNull();
    expect(seam.constructed()).toBe(0);
    expect(seam.calls()).toBe(0);
    expect(vi.mocked(createSmartApprover)).not.toHaveBeenCalled();
  });

  it('leaves a manual personality’s flag set untouched', async () => {
    const seam = smartPredicate({ approvalMode: 'manual' }, '{"decision":"deny","reason":"no"}');
    await seam.started;

    // A write that never prompted before still does not prompt.
    expect(await seam.isDangerous(payload('write_file', { path: 'notes.md' }))).toBeNull();
    expect(await seam.isDangerous(payload('terminal', { command: 'echo hi' }))).toBeNull();
    expect(seam.constructed()).toBe(0);
    expect(vi.mocked(createSmartApprover)).not.toHaveBeenCalled();
  });

  it('serves a repeated identical flagged call from the verdict cache', async () => {
    const seam = smartPredicate(
      { approvalMode: 'smart' },
      '{"decision":"deny","reason":"publishes an artifact"}',
    );
    await seam.started;

    const args = { command: 'npm run build' };
    const first = await seam.isDangerous(payload('terminal', args));
    const second = await seam.isDangerous(payload('terminal', { ...args }));

    expect(first).toBe('denied by reviewer: publishes an artifact');
    expect(second).toBe(first);
    // Two identical calls, one reviewer round-trip.
    expect(seam.calls()).toBe(1);

    // A different command is a different key, so it does pay for a review.
    await seam.isDangerous(payload('terminal', { command: 'npm run lint' }));
    expect(seam.calls()).toBe(2);
  });
});

describe('smart mode through a real agent turn', () => {
  it('routes a consequential call to the reviewer and relays the denial', async () => {
    const hooks = new DefaultHookRegistry();
    const personalities = registryWith(person('reviewed', { approvalMode: 'smart' }));
    const { provider, calls } = verdictProvider(
      '{"decision":"deny","reason":"rewrites tracked source"}',
    );
    const isDangerous = createApprovalDangerPredicate({
      executionPostureFor: () => undefined,
      hooks: [hooks],
      personalities,
      getProvider: createLazyProvider(async () => provider),
      model: 'reviewer-model',
    });
    hooks.registerModifying('before_tool_call', async (p) => {
      const reason = await isDangerous(p);
      return reason === null ? null : { error: reason };
    });

    let executed = 0;
    const tools = new DefaultToolRegistry();
    tools.register({
      name: 'write_file',
      description: 'write a file',
      schema: { type: 'object' },
      capabilities: {},
      execute: async () => {
        executed++;
        return { ok: true, value: 'written' };
      },
    });

    const loop = new AgentLoop({
      llm: toolCallingLLM('write_file', { path: 'src/index.ts', content: 'boom' }),
      tools,
      hooks,
      personalities,
      safety: createTestSafety(),
    });

    const events: AgentEvent[] = [];
    for await (const event of loop.run('rewrite it', {
      sessionKey: 'smart-mode',
      personalityId: 'reviewed',
    })) {
      events.push(event);
    }

    const toolEnd = events.find((e) => e.type === 'tool_end');
    expect(toolEnd).toMatchObject({ ok: false });
    expect(toolEnd && 'error' in toolEnd ? toolEnd.error : '').toContain(
      'denied by reviewer: rewrites tracked source',
    );
    expect(executed).toBe(0);
    expect(calls()).toBe(1);
  });
});

describe('entry-point wiring', () => {
  // The regression this guards: all three surfaces used to call
  // `createDangerPredicate()` with no arguments, which pinned every
  // personality to `manual` and made `denyRules` / `approvalMode` inert.
  const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
  const ENTRY_POINTS = [
    'apps/ethos/src/commands/serve.ts',
    'apps/ethos/src/commands/gateway.ts',
    'apps/desktop/src/main/serve.ts',
  ];

  it.each(ENTRY_POINTS)('%s builds its danger predicate with the seams', (relPath) => {
    const src = readFileSync(join(ROOT, relPath), 'utf-8');
    expect(src).toContain('createApprovalDangerPredicate({');
    expect(src).not.toMatch(/createDangerPredicate\(\s*\)/);
  });

  // Every surface that CAN prompt must flag the always-ask set. Checked at the
  // source because the value only matters at the construction site — a predicate
  // built without it is silently ungated, with no runtime signal.
  it.each(ENTRY_POINTS)('%s passes APPROVAL_SURFACE_ALWAYS_ASK', (relPath) => {
    const src = readFileSync(join(ROOT, relPath), 'utf-8');
    expect(src).toContain('alwaysAsk: APPROVAL_SURFACE_ALWAYS_ASK');
  });
});
