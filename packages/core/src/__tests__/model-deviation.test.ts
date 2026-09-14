// D17 — nothing is silent. A turn running on something other than what was
// declared says so, on the surface the turn is happening on, in the same turn.
//
// One case per D17 row that is KNOWABLE AT TURN SETUP — rows 1, 4, 5, 6, 7 and
// 8 — because those ride the single `run_start` the turn already emits.
// Cardinality is unchanged here: one `run_start` per turn. Rows 2
// (`entry-fallback`) and 3 (`chain-failover`) are discovered mid-turn, need a
// SECOND event, and are T1.15b — the two web reducers break under a second
// `run_start` (V20) and are fixed there first.
//
// The `quiet`-verbosity rule and the `once` suppression map are pinned here
// too: they are the contract, not an implementation detail of the CLI.

import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ModelDeviation,
  ModelRegistry,
  ModelResolutionContext,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { describeDeviation } from '../model-resolution';
import { createTestSafety } from './helpers/test-safety';

function makeMockLLM(): LLMProvider {
  return {
    name: 'mock',
    model: 'base-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _messages: Message[],
      _tools: unknown,
      _opts: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: 'ok' };
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

function runStartOf(events: AgentEvent[]): Extract<AgentEvent, { type: 'run_start' }> {
  const event = events.find((e) => e.type === 'run_start');
  if (event?.type !== 'run_start') throw new Error('no run_start emitted');
  return event;
}

function registry(overrides: Partial<ModelRegistry> = {}): ModelRegistry {
  return {
    entries: {
      sonnet: { alias: 'sonnet', provider: 'anthropic', modelId: 'claude-sonnet-5' },
      opus: { alias: 'opus', provider: 'anthropic', modelId: 'claude-opus-5' },
      haiku: { alias: 'haiku', provider: 'anthropic', modelId: 'claude-haiku-5' },
    },
    default: 'sonnet',
    roles: {},
    ...overrides,
  };
}

function ctx(overrides: Partial<ModelResolutionContext> = {}): ModelResolutionContext {
  return { registry: registry(), routing: {}, ...overrides };
}

function loopWith(
  resolution: ModelResolutionContext,
  personality: { id: string; name: string; model?: string },
): AgentLoop {
  const loop = new AgentLoop({
    llm: makeMockLLM(),
    safety: createTestSafety(),
    modelResolution: resolution,
  });
  // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
  loop['personalities'].define(personality);
  return loop;
}

/** The deviation on this turn's `run_start`, or `undefined`. */
async function deviationOf(
  loop: AgentLoop,
  personalityId: string,
): Promise<ModelDeviation | undefined> {
  // A session's personality is bound at creation, so each personality gets its
  // own lane — otherwise the second one refuses with `personality_locked`.
  const events = await collect(
    loop.run('hi', { personalityId, sessionKey: `cli:${personalityId}` }),
  );
  return runStartOf(events).deviation;
}

describe('D17 row 1 — role unbound', () => {
  it('announces the fall-through to the default and names what ran', async () => {
    const loop = loopWith(ctx(), { id: 'engineer', name: 'Engineer', model: 'deep' });

    const deviation = await deviationOf(loop, 'engineer');

    expect(deviation?.kind).toBe('role-unbound');
    expect(deviation?.declared).toBe('deep');
    expect(deviation?.effective).toBe('sonnet');
    expect(deviation?.declared).not.toBe(deviation?.effective);
    expect(deviation?.once).toBe(true);
    const { line, fix } = describeDeviation(deviation as ModelDeviation);
    expect(line).toContain('deep');
    expect(line).toContain('sonnet');
    expect(fix).toContain('Settings');
  });

  it('says nothing when the role IS bound', async () => {
    const loop = loopWith(ctx({ registry: registry({ roles: { deep: 'opus' } }) }), {
      id: 'engineer',
      name: 'Engineer',
      model: 'deep',
    });

    const events = await collect(loop.run('hi', { personalityId: 'engineer' }));
    const runStart = runStartOf(events);

    expect(runStart.model).toBe('claude-opus-5');
    expect(runStart.deviation).toBeUndefined();
  });

  it('says nothing when the personality declared nothing — declaring nothing IS declaring the default', async () => {
    const loop = loopWith(ctx(), { id: 'plain', name: 'Plain' });

    expect(await deviationOf(loop, 'plain')).toBeUndefined();
  });
});

// Rows 4, 5 and 6 are REFUSALS at turn setup, not deviations: nothing ran, so
// there is no `run_start` to carry one. Row 4's deviation form (a fallback or
// chain entry covered for the rejected credential) is T1.15b's second event.
describe('D17 rows 4, 5 and 6 — the refusal form', () => {
  it('row 6: a model removed from the registry while a personality names it refuses and lists what is configured', async () => {
    const loop = loopWith(ctx(), { id: 'reviewer', name: 'Reviewer', model: 'gone' });

    const events = await collect(loop.run('hi', { personalityId: 'reviewer' }));
    const error = events.find((e) => e.type === 'error');

    expect(error?.type === 'error' ? error.code : null).toBe('model_unresolved');
    const message = error?.type === 'error' ? error.error : '';
    expect(message).toContain('gone');
    expect(message).toContain('sonnet, opus, haiku');
    expect(events.some((e) => e.type === 'run_start')).toBe(false);
  });

  it('rows 4 and 5: a role bound to an alias with no entry refuses rather than rerouting', async () => {
    // The shape both rows take at turn setup: the declaration names something
    // this machine cannot run, so nothing runs. Which of the two it is (a
    // rejected key, a vendor rejecting the model id) is decided by the probe
    // path and by the provider, not here.
    const loop = loopWith(ctx({ registry: registry({ roles: { deep: 'ghost' } }) }), {
      id: 'deepthinker',
      name: 'Deep',
      model: 'deep',
    });

    const events = await collect(loop.run('hi', { personalityId: 'deepthinker' }));
    const error = events.find((e) => e.type === 'error');

    expect(error?.type === 'error' ? error.code : null).toBe('model_unresolved');
    expect(error?.type === 'error' ? error.error : '').toContain('ghost');
  });
});

describe('D17 row 7 — a legacy vendor id mapped by the D11c shim', () => {
  it('renders through describeDeviation, naming the declaration and the sunset', () => {
    // The shim itself is `mapLegacyModelDeclaration` in `model-resolution.ts`,
    // pinned row by row in `model-legacy-shim.test.ts`. What this owns is that its
    // row has a wording, and that the wording is `describeDeviation`'s.
    const { line, fix } = describeDeviation({
      kind: 'legacy-id-mapped',
      declared: 'claude-sonnet-4-6',
      effective: 'sonnet',
      reason: '',
      once: true,
    });

    expect(line).toContain('claude-sonnet-4-6');
    expect(line).toContain('sonnet');
    expect(fix).toContain('0.10.0');
  });
});

describe('D17 row 8 — a higher rung outranks the declaration', () => {
  it('names the routing override that won', async () => {
    const loop = loopWith(ctx({ routing: { researcher: 'haiku' } }), {
      id: 'researcher',
      name: 'Researcher',
      model: 'opus',
    });

    const deviation = await deviationOf(loop, 'researcher');

    expect(deviation?.kind).toBe('outranked');
    expect(deviation?.declared).toBe('opus');
    expect(deviation?.effective).toBe('haiku');
    expect(deviation?.reason).toContain('modelRouting.researcher');
    expect(deviation?.once).toBe(true);
  });

  it('names the team manifest that won, and does not fire for the personality`s own declaration', async () => {
    const outranked = loopWith(
      ctx({ teamManifest: { personalityModels: { researcher: 'haiku' } } }),
      { id: 'researcher', name: 'Researcher', model: 'opus' },
    );
    const own = loopWith(ctx(), { id: 'researcher', name: 'Researcher', model: 'opus' });

    const deviation = await deviationOf(outranked, 'researcher');
    expect(deviation?.kind).toBe('outranked');
    expect(deviation?.reason).toContain('manifest');

    expect(await deviationOf(own, 'researcher')).toBeUndefined();
  });

  it('a /model run pin is announced EVERY turn — the person typed it and the confirmation is the point', async () => {
    const loop = loopWith(ctx(), { id: 'researcher', name: 'Researcher', model: 'opus' });

    const first = runStartOf(
      await collect(loop.run('hi', { personalityId: 'researcher', modelOverride: 'haiku' })),
    );
    const second = runStartOf(
      await collect(loop.run('hi', { personalityId: 'researcher', modelOverride: 'haiku' })),
    );

    expect(first.deviation?.once).toBe(false);
    expect(first.deviation?.kind).toBe('outranked');
    expect(second.deviation?.kind).toBe('outranked');
  });
});

describe('the `once` suppression map', () => {
  it('announces on the first turn and not the second', async () => {
    const loop = loopWith(ctx(), { id: 'engineer', name: 'Engineer', model: 'deep' });

    expect(await deviationOf(loop, 'engineer')).toBeDefined();
    expect(await deviationOf(loop, 'engineer')).toBeUndefined();
  });

  it('re-announces after a restart — a fresh loop knows nothing of the old process', async () => {
    const first = loopWith(ctx(), { id: 'engineer', name: 'Engineer', model: 'deep' });
    expect(await deviationOf(first, 'engineer')).toBeDefined();
    expect(await deviationOf(first, 'engineer')).toBeUndefined();

    const restarted = loopWith(ctx(), { id: 'engineer', name: 'Engineer', model: 'deep' });
    expect(await deviationOf(restarted, 'engineer')).toBeDefined();
  });

  it('announces once across lanes on a gateway, not once per lane', async () => {
    // One loop serves many chats; "session" means the LOOP. A config fact is
    // about the deployment, not about the person in a given lane, and
    // announcing per lane would repeat one machine-level fact to every user of
    // a shared bot.
    const loop = loopWith(ctx(), { id: 'engineer', name: 'Engineer', model: 'deep' });

    const laneA = runStartOf(
      await collect(loop.run('hi', { personalityId: 'engineer', sessionKey: 'telegram:111' })),
    );
    const laneB = runStartOf(
      await collect(loop.run('hi', { personalityId: 'engineer', sessionKey: 'telegram:222' })),
    );

    expect(laneA.deviation).toBeDefined();
    expect(laneB.deviation).toBeUndefined();
  });

  it('suppresses per (personalityId, kind, declared), so a different personality still announces', async () => {
    const loop = new AgentLoop({
      llm: makeMockLLM(),
      safety: createTestSafety(),
      modelResolution: ctx(),
    });
    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({ id: 'one', name: 'One', model: 'deep' });
    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({ id: 'two', name: 'Two', model: 'deep' });

    expect(await deviationOf(loop, 'one')).toBeDefined();
    expect(await deviationOf(loop, 'two')).toBeDefined();
    expect(await deviationOf(loop, 'one')).toBeUndefined();
  });
});
