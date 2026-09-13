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
