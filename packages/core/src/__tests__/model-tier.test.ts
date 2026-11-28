// The routing ladder, end to end, through the ONE resolver (D7).
//
// Every case asserts the model the PROVIDER was actually asked to serve
// (`modelOverride ?? llm.model`, which is exactly what every provider
// implementation resolves), not an internal variable: a precedence rule
// verified against a private field is a rule that drifts the first time the
// plumbing moves.
//
// What changed with T1.5: the `personality.provider === llm.name` guard is
// gone (D8), so a declaration is applied on a chained deployment (V2) and a
// plain-string declaration is applied at all (V1) — but only against a
// REGISTRY, because a declaration is now an alias or a role, never a raw vendor
// id. A deployment with no registry keeps today's behaviour exactly (D11b).

import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ModelRegistry,
  ModelResolutionContext,
  PersonalityConfig,
  Tool,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { ChainedProvider, tagProviderEntry } from '../providers/chained-provider';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

function makeMockLLM(onComplete?: (opts: CompletionOptions) => void): LLMProvider {
  return {
    name: 'mock',
    model: 'base-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _messages: Message[],
      _tools: unknown,
      opts: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      onComplete?.(opts);
      yield { type: 'text_delta', text: 'ok' };
      yield {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: 0.0001,
        },
      };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

/** A roster whose aliases are the names the old tier maps used as raw ids. */
function registry(): ModelRegistry {
  return {
    entries: {
      haiku: { alias: 'haiku', provider: 'anthropic', modelId: 'claude-haiku-5' },
      sonnet: { alias: 'sonnet', provider: 'anthropic', modelId: 'claude-sonnet-5' },
      opus: { alias: 'opus', provider: 'anthropic', modelId: 'claude-opus-5' },
      'override-model': {
        alias: 'override-model',
        provider: 'anthropic',
        modelId: 'operator-choice',
      },
    },
    default: 'sonnet',
    roles: { deep: 'opus' },
  };
}

function ctx(overrides: Partial<ModelResolutionContext> = {}): ModelResolutionContext {
  return { registry: registry(), routing: {}, ...overrides };
}

function runStartOf(events: AgentEvent[]): Extract<AgentEvent, { type: 'run_start' }> {
  const event = events.find((e) => e.type === 'run_start');
  if (event?.type !== 'run_start') throw new Error('no run_start emitted');
  return event;
}

describe('Model tier resolution', () => {
  it('uses the default-role leaf of a tier map', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({ llm, safety: createTestSafety(), modelResolution: ctx() });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'tiered',
      name: 'Tiered',
      model: { trivial: 'haiku', default: 'sonnet', deep: 'opus' },
    });

    await collect(loop.run('hi', { personalityId: 'tiered' }));

    expect(onComplete).toHaveBeenCalled();
    const opts = onComplete.mock.calls[0]?.[0];
    expect(opts?.modelOverride).toBe('claude-sonnet-5');
  });

  // V2 — the defect this task closes. On a chained deployment the active LLM's
  // name is `chain(a,b)`, which no personality can declare, so the deleted
  // guard made EVERY tier map inert. The personality below declares a provider
  // that matches nothing; its declaration is applied anyway.
  it('a tier map is honoured on a chained deployment', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const chained: LLMProvider = { ...llm, name: 'chain(anthropic,openrouter)' };
    const loop = new AgentLoop({
      llm: chained,
      safety: createTestSafety(),
      modelResolution: ctx(),
    });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'tiered',
      name: 'Tiered',
      provider: 'anthropic',
      model: { trivial: 'haiku', default: 'sonnet', deep: 'opus' },
    });

    await collect(loop.run('hi', { personalityId: 'tiered' }));

    expect(onComplete.mock.calls[0]?.[0]?.modelOverride).toBe('claude-sonnet-5');
  });

  // V1 — 4 of 6 shipped built-ins declare a plain string, and it was NEVER
  // applied: the old resolver required `typeof model === 'object'`.
  it('a plain-string model is applied', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({ llm, safety: createTestSafety(), modelResolution: ctx() });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({ id: 'plain', name: 'Plain', model: 'opus' });

    await collect(loop.run('hi', { personalityId: 'plain' }));

    expect(onComplete.mock.calls[0]?.[0]?.modelOverride).toBe('claude-opus-5');
  });

  it('a plain-string ROLE declaration resolves through its binding', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({ llm, safety: createTestSafety(), modelResolution: ctx() });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({ id: 'deepthinker', name: 'Deep', model: 'deep' });

    await collect(loop.run('hi', { personalityId: 'deepthinker' }));

    expect(onComplete.mock.calls[0]?.[0]?.modelOverride).toBe('claude-opus-5');
  });

  it('tierOverride in RunOptions makes the turn use the deep tier', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({ llm, safety: createTestSafety(), modelResolution: ctx() });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'tiered',
      name: 'Tiered',
      model: { trivial: 'haiku', default: 'sonnet', deep: 'opus' },
    });

    await collect(loop.run('think hard', { personalityId: 'tiered', tierOverride: 'deep' }));

    expect(onComplete.mock.calls[0]?.[0]?.modelOverride).toBe('claude-opus-5');
  });

  it('tierOverride "dreaming" uses the declared dreaming model (background maintenance turns)', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({ llm, safety: createTestSafety(), modelResolution: ctx() });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'tiered',
      name: 'Tiered',
      model: { default: 'sonnet', dreaming: 'haiku' },
    });

    await collect(loop.run('consolidate', { personalityId: 'tiered', tierOverride: 'dreaming' }));

    expect(onComplete.mock.calls[0]?.[0]?.modelOverride).toBe('claude-haiku-5');
  });

  it('tierOverride is per-run (second run without it uses default)', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({ llm, safety: createTestSafety(), modelResolution: ctx() });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'tiered',
      name: 'Tiered',
      model: { trivial: 'haiku', default: 'sonnet', deep: 'opus' },
    });

    await collect(loop.run('first', { personalityId: 'tiered', tierOverride: 'deep' }));
    await collect(loop.run('second', { personalityId: 'tiered' }));

    expect(onComplete.mock.calls[0]?.[0]?.modelOverride).toBe('claude-opus-5');
    expect(onComplete.mock.calls[1]?.[0]?.modelOverride).toBe('claude-sonnet-5');
  });

  it('modelRouting override takes precedence over the declaration', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({
      llm,
      safety: createTestSafety(),
      modelResolution: ctx({ routing: { tiered: 'override-model' } }),
    });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'tiered',
      name: 'Tiered',
      model: { trivial: 'haiku', default: 'sonnet', deep: 'opus' },
    });

    await collect(loop.run('hi', { personalityId: 'tiered' }));

    expect(onComplete.mock.calls[0]?.[0]?.modelOverride).toBe('operator-choice');
  });

  it('emits run_start with the resolved model, provider entry and rung', async () => {
    const llm = makeMockLLM();
    const loop = new AgentLoop({ llm, safety: createTestSafety(), modelResolution: ctx() });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'tiered',
      name: 'Tiered',
      model: { trivial: 'haiku', default: 'sonnet', deep: 'opus' },
    });

    const runStart = runStartOf(await collect(loop.run('hi', { personalityId: 'tiered' })));

    expect(runStart.model).toBe('claude-sonnet-5');
    expect(runStart.provider).toBe('anthropic');
    expect(runStart.source).toBe('personality');
    expect(runStart.deviation).toBeUndefined();
  });
});

// D6/D14 — a declaration that names nothing this machine has refuses the turn.
describe('model_unresolved', () => {
  it('an unknown alias refuses the turn and names the configured aliases', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({ llm, safety: createTestSafety(), modelResolution: ctx() });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({ id: 'lost', name: 'Lost', model: 'gpt5-mini' });

    const events = await collect(loop.run('hi', { personalityId: 'lost' }));
    const error = events.find((e) => e.type === 'error');

    expect(error?.type === 'error' ? error.code : null).toBe('model_unresolved');
    const message = error?.type === 'error' ? error.error : '';
    expect(message).toContain('gpt5-mini');
    expect(message).toContain('sonnet');
    expect(message).toContain('opus');
    // Nothing ran: a refusal, never a silent reroute.
    expect(onComplete).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'run_start')).toBe(false);
  });
});

// D11b — the single most important backward-compatibility property in this
// task. Every deployment that upgrades into this release has no registry.
describe('an empty registry behaves exactly as today', () => {
  it('runs the deployment default when nothing is declared', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({ llm, safety: createTestSafety() });

    const events = await collect(loop.run('hi'));

    expect(onComplete.mock.calls[0]?.[0]?.modelOverride).toBeUndefined();
    const runStart = runStartOf(events);
    expect(runStart.model).toBe('base-model');
    expect(runStart.source).toBe('default');
    expect(runStart.deviation).toBeUndefined();
  });

  it('does not refuse, and does not apply, a declaration it cannot resolve', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({ llm, safety: createTestSafety() });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'tiered',
      name: 'Tiered',
      provider: 'anthropic',
      model: { default: 'claude-sonnet-4-6' },
    });

    const events = await collect(loop.run('hi', { personalityId: 'tiered' }));

    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(onComplete.mock.calls[0]?.[0]?.modelOverride).toBeUndefined();
  });

  it('still honours modelRouting and a run pin', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({
      llm,
      safety: createTestSafety(),
      modelResolution: {
        registry: { entries: {}, roles: {} },
        routing: { routed: 'routed-model' },
      },
    });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({ id: 'routed', name: 'Routed' });

    await collect(loop.run('hi', { personalityId: 'routed' }));
    expect(onComplete.mock.calls[0]?.[0]?.modelOverride).toBe('routed-model');

    onComplete.mockClear();
    await collect(loop.run('hi', { personalityId: 'routed', modelOverride: 'pinned-model' }));
    expect(onComplete.mock.calls[0]?.[0]?.modelOverride).toBe('pinned-model');
  });
});

// V10/V17 — the one-shot `think_deeper` escalation. The flag is SET in
// `tool-processing.ts` and CONSUMED in `stream-step.ts`; both sites carried a
// `typeof personality.model === 'object'` gate, and the setting site carried
// the provider guard too, so a plain-string personality could not escalate at
// all.
describe('think_deeper escalation', () => {
  function thinkDeeper(): Tool {
    return {
      name: 'think_deeper',
      description: 'escalate',
      schema: { type: 'object' },
      capabilities: {},
      async execute(): Promise<ToolResult> {
        return { ok: true, value: 'thinking harder' };
      },
    };
  }

  /** A loop whose registry holds `think_deeper`. */
  function escalatingLoop(llm: LLMProvider, personality: PersonalityConfig): AgentLoop {
    const tools = new DefaultToolRegistry();
    tools.register(thinkDeeper());
    const loop = new AgentLoop({ llm, tools, safety: createTestSafety(), modelResolution: ctx() });
    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define(personality);
    return loop;
  }

  /** An LLM that calls `think_deeper` on its first turn, then answers. */
  function escalatingLLM(onComplete: (opts: CompletionOptions) => void): LLMProvider {
    let call = 0;
    return {
      name: 'mock',
      model: 'base-model',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(
        _messages: Message[],
        _tools: unknown,
        opts: CompletionOptions,
      ): AsyncIterable<CompletionChunk> {
        onComplete(opts);
        call += 1;
        if (call === 1) {
          yield { type: 'tool_use_start', toolCallId: 'tc1', toolName: 'think_deeper' };
          yield { type: 'tool_use_delta', toolCallId: 'tc1', partialJson: '{}' };
          yield { type: 'tool_use_end', toolCallId: 'tc1', inputJson: '{}' };
          yield { type: 'done', finishReason: 'tool_use' };
          return;
        }
        yield { type: 'text_delta', text: 'answered deeply' };
        yield { type: 'done', finishReason: 'end_turn' };
      },
      async countTokens() {
        return 10;
      },
    };
  }

  // "A plain-string declaration" means the string form, as against the tier
  // MAP the old code required (`typeof model === 'object'`). A string naming a
  // ROLE escalates through the role bindings, as here. A string naming an
  // ALIAS does not, and that is the D7 rung table rather than a defect: an
  // alias at rung 3 is a pin — the author naming one model — and it terminates
  // before rung 4 is reached, exactly as a `/tier deep` on the same
  // personality does.
  it('escalates from a plain-string declaration', async () => {
    const onComplete = vi.fn();
    const llm = escalatingLLM(onComplete);
    const loop = escalatingLoop(llm, {
      id: 'plain',
      name: 'Plain',
      model: 'default',
      toolset: ['think_deeper'],
    });

    await collect(loop.run('hi', { personalityId: 'plain' }));

    expect(onComplete.mock.calls[0]?.[0]?.modelOverride).toBe('claude-sonnet-5');
    // The second LLM call runs on the `deep` binding, not on the declaration.
    expect(onComplete.mock.calls[1]?.[0]?.modelOverride).toBe('claude-opus-5');
  });

  it('sets the escalation flag for a string declaration, not only consumes it', async () => {
    // The flag lives on the turn context that `tool-processing` writes and
    // `stream-step` reads. Asserted through the only observable it has: the
    // second call's model. With the setting site still guarded, the second
    // call would repeat the first one's model.
    const onComplete = vi.fn();
    const llm = escalatingLLM(onComplete);
    const loop = escalatingLoop(llm, {
      id: 'chained',
      name: 'Chained',
      // A provider no active LLM name can match — the V17 case.
      provider: 'anthropic',
      model: 'default',
      toolset: ['think_deeper'],
    });

    await collect(loop.run('hi', { personalityId: 'chained' }));

    expect(onComplete.mock.calls[1]?.[0]?.modelOverride).toBe('claude-opus-5');
    expect(onComplete.mock.calls[1]?.[0]?.modelOverride).not.toBe(
      onComplete.mock.calls[0]?.[0]?.modelOverride,
    );
  });
});

// Task 1.1 (plan think-deeper-tier-switch) — the whole round trip, scripted
// call by call. The flag is SET in `tool-processing.ts` and CONSUMED in
// `stream-step.ts` (`describe('think_deeper escalation')` above pins call 2;
// this pins calls 3 and 4 too).
type ScriptCall = { tool: 'think_deeper' | 'noop'; args?: Record<string, unknown> };
type ScriptStep = ScriptCall | { batch: ScriptCall[] } | 'text';

function noopTool(): Tool {
  return {
    name: 'noop',
    description: 'does nothing',
    schema: { type: 'object' },
    capabilities: {},
    async execute(): Promise<ToolResult> {
      return { ok: true, value: 'done' };
    },
  };
}

function thinkDeeperTool(): Tool {
  return {
    name: 'think_deeper',
    description: 'escalate',
    schema: { type: 'object' },
    capabilities: {},
    async execute(): Promise<ToolResult> {
      return { ok: true, value: 'thinking harder' };
    },
  };
}

/** An LLM that plays one `ScriptStep` per call and reports each call's options. */
function scriptedLLM(
  script: ScriptStep[],
  onComplete: (opts: CompletionOptions) => void,
  usageCost?: (call: number) => number,
  model = 'base-model',
): LLMProvider {
  let call = 0;
  return {
    name: 'mock',
    model,
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _messages: Message[],
      _tools: unknown,
      opts: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      onComplete(opts);
      const step = script[call] ?? 'text';
      call += 1;
      if (usageCost) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            estimatedCostUsd: usageCost(call),
          },
        };
      }
      if (step === 'text') {
        yield { type: 'text_delta', text: `answer ${call}` };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      const calls = 'batch' in step ? step.batch : [step];
      for (const [i, c] of calls.entries()) {
        const id = `tc${call}-${i}`;
        const json = JSON.stringify(c.args ?? {});
        yield { type: 'tool_use_start', toolCallId: id, toolName: c.tool };
        yield { type: 'tool_use_delta', toolCallId: id, partialJson: json };
        yield { type: 'tool_use_end', toolCallId: id, inputJson: json };
      }
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 10;
    },
  };
}

function scriptedLoop(
  llm: LLMProvider,
  personality: PersonalityConfig,
  modelResolution: ModelResolutionContext = ctx(),
  extra: Partial<ConstructorParameters<typeof AgentLoop>[0]> = {},
): AgentLoop {
  const tools = new DefaultToolRegistry();
  tools.register(thinkDeeperTool());
  tools.register(noopTool());
  const loop = new AgentLoop({
    llm,
    tools,
    safety: createTestSafety(),
    modelResolution,
    ...extra,
  });
  // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
  loop['personalities'].define(personality);
  return loop;
}

const ESCALATING: PersonalityConfig = {
  id: 'esc',
  name: 'Esc',
  model: 'default',
  toolset: ['think_deeper', 'noop'],
};

function servedModels(calls: ReturnType<typeof vi.fn>): (string | undefined)[] {
  return calls.mock.calls.map((c) => (c[0] as CompletionOptions).modelOverride);
}

describe('think_deeper round trip', () => {
  it('one-shot: call 2 runs on deep, call 3 returns to the turn model', async () => {
    const onComplete = vi.fn();
    const llm = scriptedLLM(
      [{ tool: 'think_deeper', args: { reason: 'race condition' } }, { tool: 'noop' }, 'text'],
      onComplete,
    );
    const loop = scriptedLoop(llm, ESCALATING);

    await collect(loop.run('hi', { personalityId: 'esc' }));

    expect(servedModels(onComplete)).toEqual([
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-sonnet-5',
    ]);
  });

  it('escalates again only when called again', async () => {
    const onComplete = vi.fn();
    const llm = scriptedLLM(
      [
        { tool: 'think_deeper', args: { reason: 'a' } },
        { tool: 'think_deeper', args: { reason: 'b' } },
        { tool: 'noop' },
        'text',
      ],
      onComplete,
    );
    const loop = scriptedLoop(llm, ESCALATING);

    await collect(loop.run('hi', { personalityId: 'esc' }));

    expect(servedModels(onComplete)).toEqual([
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-opus-5',
      'claude-sonnet-5',
    ]);
  });

  it('an unresolvable deep keeps the turn model', async () => {
    const onComplete = vi.fn();
    const llm = scriptedLLM(
      [{ tool: 'think_deeper', args: { reason: 'hard' } }, { tool: 'noop' }, 'text'],
      onComplete,
    );
    const noDeep: ModelRegistry = { ...registry(), roles: {} };
    const loop = scriptedLoop(llm, ESCALATING, ctx({ registry: noDeep }));

    const events = await collect(loop.run('hi', { personalityId: 'esc' }));

    const served = servedModels(onComplete);
    expect(served[1]).toBe(served[0]);
    expect(served[2]).toBe(served[0]);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});

describe('watcher pause after think_deeper', () => {
  // `replyAfterWatcherPause` (stages/watcher-pause.ts) clears the pending flag:
  // the closing reply of a paused turn does not run on deep.
  it('the closing reply stays on the turn model', async () => {
    const onComplete = vi.fn();
    const llm = scriptedLLM(
      [{ tool: 'think_deeper', args: { reason: 'hard' } }, 'text'],
      onComplete,
    );
    const tools = new DefaultToolRegistry();
    tools.register(thinkDeeperTool());
    const loop = new AgentLoop({
      llm,
      tools,
      safety: createTestSafety({
        watcher: {
          resetTurn() {},
          observe: (e: { type: string }) =>
            e.type === 'tool_end'
              ? ({ action: 'pause', rule: 'test-rule', reason: 'paused' } as const)
              : ({ action: 'allow' } as const),
        },
      }),
      modelResolution: ctx(),
    });
    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define(ESCALATING);

    const events = await collect(loop.run('hi', { personalityId: 'esc' }));

    expect(servedModels(onComplete)).toEqual(['claude-sonnet-5', 'claude-sonnet-5']);
    expect(events.filter((e) => e.type === 'tier_escalation')).toHaveLength(0);
  });
});

type TierEscalationEvent = Extract<AgentEvent, { type: 'tier_escalation' }>;

function escalationsOf(events: AgentEvent[]): TierEscalationEvent[] {
  return events.filter((e): e is TierEscalationEvent => e.type === 'tier_escalation');
}

// Task 2.2 — the user is told exactly when the model really changed.
describe('tier_escalation event', () => {
  it('is yielded once, before the escalated call streams, with the cleaned reason', async () => {
    const llm = scriptedLLM(
      [{ tool: 'think_deeper', args: { reason: '  race\n condition \u001b[31m' } }, 'text'],
      vi.fn(),
    );
    const loop = scriptedLoop(llm, ESCALATING);

    const events = await collect(loop.run('hi', { personalityId: 'esc' }));

    const found = escalationsOf(events);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      type: 'tier_escalation',
      from: 'default',
      to: 'deep',
      model: 'claude-opus-5',
      reason: 'race condition',
    });
    const at = events.findIndex((e) => e.type === 'tier_escalation');
    const firstTextAfter = events.findIndex((e, i) => i > at && e.type === 'text_delta');
    expect(at).toBeGreaterThan(-1);
    expect(firstTextAfter).toBeGreaterThan(at);
  });

  it('is not yielded when deep does not resolve', async () => {
    const llm = scriptedLLM([{ tool: 'think_deeper', args: { reason: 'hard' } }, 'text'], vi.fn());
    const noDeep: ModelRegistry = { ...registry(), roles: {} };
    const loop = scriptedLoop(llm, ESCALATING, ctx({ registry: noDeep }));

    const events = await collect(loop.run('hi', { personalityId: 'esc' }));

    expect(escalationsOf(events)).toHaveLength(0);
  });

  it('is not yielded when the escalated model equals the current one', async () => {
    const onComplete = vi.fn();
    const llm = scriptedLLM(
      [{ tool: 'think_deeper', args: { reason: 'hard' } }, 'text'],
      onComplete,
    );
    const loop = scriptedLoop(llm, ESCALATING);

    // `/tier deep`: the turn already runs on the deep model.
    const events = await collect(loop.run('hi', { personalityId: 'esc', tierOverride: 'deep' }));

    expect(servedModels(onComplete)).toEqual(['claude-opus-5', 'claude-opus-5']);
    expect(escalationsOf(events)).toHaveLength(0);
  });

  it('names the served model when deep maps to a non-primary chain entry', async () => {
    const codexCalls = vi.fn();
    const qwenCalls = vi.fn();
    const codex = scriptedLLM(
      [{ tool: 'think_deeper', args: { reason: 'hard' } }, 'text'],
      codexCalls,
      undefined,
      'gpt-5.6-terra',
    );
    const qwen = scriptedLLM(['text'], qwenCalls, undefined, 'qwen3.8-flash-next');
    const chainRegistry: ModelRegistry = {
      entries: {
        terra: { alias: 'terra', provider: 'codex', modelId: 'gpt-5.6-terra' },
        qwen: { alias: 'qwen', provider: 'compat', modelId: 'qwen3.8-flash-next' },
      },
      default: 'terra',
      roles: {},
    };
    // The personality NAMES deep, so the escalation is pinned to that entry.
    const loop = scriptedLoop(
      new ChainedProvider([tagProviderEntry(codex, 'codex'), tagProviderEntry(qwen, 'compat')]),
      { ...ESCALATING, model: { default: 'terra', deep: 'qwen' } },
      ctx({ registry: chainRegistry }),
    );

    const events = await collect(loop.run('hi', { personalityId: 'esc' }));

    // The escalated call really went to the qwen hop...
    expect(qwenCalls).toHaveBeenCalledTimes(1);
    // ...so the user is told, and told the model that served it.
    const found = escalationsOf(events);
    expect(found).toHaveLength(1);
    expect(found[0]?.model).toBe('qwen3.8-flash-next');
  });

  it('records the cleaned reason in the observability row', async () => {
    const recorded = vi.fn();
    const llm = scriptedLLM(
      [{ tool: 'think_deeper', args: { reason: 'race condition' } }, 'text'],
      vi.fn(),
    );
    const loop = scriptedLoop(llm, ESCALATING, ctx(), {
      observability: {
        startTurnTrace: () => 'trace-1',
        endTrace: () => {},
        startSpan: () => 'span-1',
        endSpan: () => {},
        recordSafetyBlock: () => {},
        recordCompaction: () => {},
        recordTierEscalation: recorded,
        recordTierOverride: () => {},
        flush: () => {},
      },
    });

    await collect(loop.run('hi', { personalityId: 'esc' }));

    expect(recorded).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'tool_escalation', detail: 'race condition', to: 'deep' }),
    );
  });
});

// Task 3.1 — `checkEscalationCap` (agent-loop/tier-escalation.ts) rejects in the
// prep loop of tool-processing.ts, before the tool runs.
describe('escalation caps', () => {
  const td = (reason: string): ScriptStep => ({ tool: 'think_deeper', args: { reason } });

  it('rejects the third think_deeper of a turn and stays on the turn model', async () => {
    const onComplete = vi.fn();
    const llm = scriptedLLM([td('a'), td('b'), td('c'), { tool: 'noop' }, 'text'], onComplete);
    const loop = scriptedLoop(llm, ESCALATING);

    const events = await collect(loop.run('hi', { personalityId: 'esc' }));

    expect(servedModels(onComplete)).toEqual([
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-sonnet-5',
    ]);
    expect(escalationsOf(events)).toHaveLength(2);
    const ends = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool_end' }> =>
        e.type === 'tool_end' && e.toolName === 'think_deeper',
    );
    expect(ends.map((e) => e.ok)).toEqual([true, true, false]);
    expect(ends[2]?.error).toBe(
      'Escalation limit reached for this turn (2). Continue on the current model.',
    );
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('counts one escalation per batch', async () => {
    // Two think_deeper calls in ONE response count once (perTurn 1, not 2): a
    // third is still allowed, and only the fourth is refused.
    const llm = scriptedLLM(
      [{ batch: [td('a'), td('b')] }, td('c'), td('d'), { tool: 'noop' }, 'text'],
      vi.fn(),
    );
    const loop = scriptedLoop(llm, ESCALATING);

    const events = await collect(loop.run('hi', { personalityId: 'esc' }));

    expect(escalationsOf(events)).toHaveLength(2);
    const ends = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool_end' }> =>
        e.type === 'tool_end' && e.toolName === 'think_deeper',
    );
    expect(ends.map((e) => e.ok)).toEqual([true, true, true, false]);
  });

  it('counts per session across runs, resets with resetSessionCost, and is per sessionKey', async () => {
    const onComplete = vi.fn();
    // 10 runs of [think_deeper, text], then 3 more runs.
    const script: ScriptStep[] = Array.from(
      { length: 13 },
      (_, i) => [td(`r${i}`), 'text'] as ScriptStep[],
    ).flat();
    const llm = scriptedLLM(script, onComplete);
    const loop = scriptedLoop(llm, ESCALATING);
    const run = async (sessionKey: string) =>
      collect(loop.run('hi', { personalityId: 'esc', sessionKey }));

    for (let i = 0; i < 10; i++) {
      expect(escalationsOf(await run('s1'))).toHaveLength(1);
    }
    // 11th escalation of s1 is refused; the next call stays on the turn model.
    onComplete.mockClear();
    const refused = await run('s1');
    expect(escalationsOf(refused)).toHaveLength(0);
    expect(servedModels(onComplete)).toEqual(['claude-sonnet-5', 'claude-sonnet-5']);

    // A different session is not affected.
    expect(escalationsOf(await run('s2'))).toHaveLength(1);

    // /new and /personality reset the count with the spend counter.
    loop.resetSessionCost('s1');
    expect(escalationsOf(await run('s1'))).toHaveLength(1);
  });

  it('a rejected call does not count against the session or trip the denial streak', async () => {
    // Run 1: two escalations, then three refusals in a row (they would trip
    // MAX_CONSECUTIVE_DENIALS if they counted as denials).
    const script: ScriptStep[] = [
      td('a'),
      td('b'),
      td('c'),
      td('d'),
      td('e'),
      { tool: 'noop' },
      'text',
      // Runs 2-9: one escalation each (2 + 8 = 10); run 10 is refused.
      ...Array.from({ length: 9 }, () => [td('x'), 'text'] as ScriptStep[]).flat(),
    ];
    const llm = scriptedLLM(script, vi.fn());
    const loop = scriptedLoop(llm, ESCALATING);
    const run = (): Promise<AgentEvent[]> =>
      collect(loop.run('hi', { personalityId: 'esc', sessionKey: 'rej' }));

    const first = await run();
    expect(first.some((e) => e.type === 'halt')).toBe(false);
    expect(first.find((e) => e.type === 'done')).toBeDefined();
    expect(escalationsOf(first)).toHaveLength(2);

    // The three refusals did not count: eight more escalations still fit.
    for (let i = 0; i < 8; i++) expect(escalationsOf(await run())).toHaveLength(1);
    // 2 + 8 = 10: the next one is refused.
    expect(escalationsOf(await run())).toHaveLength(0);
  });
});

// Task 3.2 — deep spend is session spend: every `usage` event folds into
// `sessionCosts` (stream-step.ts) and `checkCostBudget` reads it next iteration.
describe('escalated spend and the session budget', () => {
  const costOf = (call: number): number => (call === 2 ? 0.2 : 0.01);

  it('sums fast and deep calls into the session cost', async () => {
    const llm = scriptedLLM(
      [{ tool: 'think_deeper', args: { reason: 'hard' } }, { tool: 'noop' }, 'text'],
      vi.fn(),
      costOf,
    );
    const loop = scriptedLoop(llm, ESCALATING);

    await collect(loop.run('hi', { personalityId: 'esc', sessionKey: 'cost' }));

    expect(loop.getSessionCost('cost')).toBeCloseTo(0.01 + 0.2 + 0.01, 10);
  });

  it('halts the iteration after the deep call when it crosses budgetCapUsd', async () => {
    const llm = scriptedLLM(
      [{ tool: 'think_deeper', args: { reason: 'hard' } }, { tool: 'noop' }, 'text'],
      vi.fn(),
      costOf,
    );
    const loop = scriptedLoop(llm, { ...ESCALATING, budgetCapUsd: 0.15 });

    const events = await collect(loop.run('hi', { personalityId: 'esc', sessionKey: 'cap' }));

    const halt = events.find((e): e is Extract<AgentEvent, { type: 'halt' }> => e.type === 'halt');
    expect(halt?.rule).toBe('cost-cap');
    expect(halt?.kind).toBe('budget');
  });
});

// The rungs, asserted against what the provider was asked to serve.
describe('model routing precedence', () => {
  /** The model this turn really ran on, from the provider's point of view. */
  function servedModel(onComplete: ReturnType<typeof vi.fn>, llm: LLMProvider): string {
    const opts = onComplete.mock.calls[0]?.[0] as CompletionOptions | undefined;
    return opts?.modelOverride ?? llm.model;
  }

  function tieredLoop(onComplete: (opts: CompletionOptions) => void): {
    loop: AgentLoop;
    llm: LLMProvider;
  } {
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({ llm, safety: createTestSafety(), modelResolution: ctx() });
    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'tiered',
      name: 'Tiered',
      model: { default: 'sonnet', deep: 'opus' },
    });
    return { loop, llm };
  }

  it('rung 0: an explicit modelOverride beats tierOverride, the declaration and the default', async () => {
    const onComplete = vi.fn();
    const { loop, llm } = tieredLoop(onComplete);

    await collect(
      loop.run('hi', { personalityId: 'tiered', tierOverride: 'deep', modelOverride: 'haiku' }),
    );

    expect(servedModel(onComplete, llm)).toBe('claude-haiku-5');
  });

  it('rung 2: modelRouting beats the declaration', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({
      llm,
      safety: createTestSafety(),
      modelResolution: ctx({ routing: { tiered: 'haiku' } }),
    });
    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({ id: 'tiered', name: 'Tiered', model: { default: 'sonnet' } });

    await collect(loop.run('hi', { personalityId: 'tiered' }));

    expect(servedModel(onComplete, llm)).toBe('claude-haiku-5');
  });

  it('rung 3: the declaration beats the registry default', async () => {
    const onComplete = vi.fn();
    const { loop, llm } = tieredLoop(onComplete);

    await collect(loop.run('hi', { personalityId: 'tiered', tierOverride: 'deep' }));

    expect(servedModel(onComplete, llm)).toBe('claude-opus-5');
  });

  it('rung 5: nothing declared -> the registry default serves the turn', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({ llm, safety: createTestSafety(), modelResolution: ctx() });

    await collect(loop.run('hi'));

    expect(servedModel(onComplete, llm)).toBe('claude-sonnet-5');
  });

  it('a pin is per-run: the next turn without one routes normally again', async () => {
    const onComplete = vi.fn();
    const { loop, llm } = tieredLoop(onComplete);

    await collect(loop.run('first', { personalityId: 'tiered', modelOverride: 'haiku' }));
    expect(servedModel(onComplete, llm)).toBe('claude-haiku-5');

    onComplete.mockClear();
    await collect(loop.run('second', { personalityId: 'tiered' }));
    expect(servedModel(onComplete, llm)).toBe('claude-sonnet-5');
  });

  it('run_start names the pinned model, so telemetry cannot claim the default answered', async () => {
    const llm = makeMockLLM();
    const loop = new AgentLoop({ llm, safety: createTestSafety(), modelResolution: ctx() });

    const runStart = runStartOf(await collect(loop.run('hi', { modelOverride: 'haiku' })));

    expect(runStart.model).toBe('claude-haiku-5');
    expect(runStart.source).toBe('run-override');
  });
});
