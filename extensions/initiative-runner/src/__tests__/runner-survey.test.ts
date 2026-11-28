import { AgentLoop, DefaultPersonalityRegistry, DefaultToolRegistry } from '@ethosagent/core';
import type {
  CompletionChunk,
  ExplorationRow,
  IdeaRow,
  LLMProvider,
  Tool,
  WindowKind,
} from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { InitiativeFileSchema } from '../config-schema';
import { createInitiativeRunner, type RunnerStore } from '../runner';

const FILE = InitiativeFileSchema.parse({
  id: 'self-serve-activation',
  version: 1,
  origin: 'human',
  created_in: 'chat',
  state: 'active',
  title: 'Self-serve activation',
  outcome: 'More trials reach the first project',
  sources: ['sessions', 'web'],
  guidance: [{ text: 'prefer funnel data over anecdotes', status: 'mapped' }],
  autonomy: { mode: 'ask' },
  budget: { usd_per_day: 3, usd_per_exploration: 1, max_open_explorations: 3 },
  timeline: {
    explore_windows: ['every 6h'],
    window_minutes: 20,
    default_days: 7,
    review_on: '2026-12-20',
  },
  delivery: { owner_channel: 'telegram:1', digest_time: '09:00' },
});

interface Closed {
  spentUsd: number;
  toolsUsed: string[];
  reads: string[];
  endReason: string;
}

/** In-memory store: just the calls a run makes. */
function fakeStore(opts: { seedIdeas?: string[] } = {}) {
  const ideas: IdeaRow[] = (opts.seedIdeas ?? []).map((text, i) => ({
    id: `IDEA-${i + 1}`,
    initiativeId: FILE.id,
    origin: 'human',
    text,
    sourceRef: null,
    createdAt: 'now',
  }));
  const explorations: ExplorationRow[] = [];
  const windows: Array<{ id: string; kind: WindowKind; closed?: Closed }> = [];
  const store: RunnerStore = {
    openWindow: (w) => {
      const id = `W-${windows.length + 1}`;
      windows.push({ id, kind: w.kind });
      return id;
    },
    closeWindow: (id, r) => {
      const w = windows.find((x) => x.id === id);
      if (w) w.closed = r;
    },
    getExploration: (id) => explorations.find((e) => e.id === id) ?? null,
    explorations: () => [...explorations],
    ideas: () => [...ideas],
    budget: () => ({ spentUsd: 0, capUsd: 0, explorationsOpen: 0 }),
    get: () => null,
  };
  const propose = (q: { ideaId: string | null; question: string; estimateUsd: number }) => {
    const row: ExplorationRow = {
      id: `EXP-${explorations.length + 1}`,
      initiativeId: FILE.id,
      ideaId: q.ideaId,
      question: q.question,
      state: 'proposed',
      budgetUsd: 0,
      spentUsd: 0,
      deadline: 'later',
      estimateUsd: q.estimateUsd,
    };
    explorations.push(row);
    return row;
  };
  return { store, explorations, windows, propose };
}

function proposeTool(propose: ReturnType<typeof fakeStore>['propose']): Tool {
  return {
    name: 'initiative_propose',
    description: 'propose',
    toolset: 'initiative',
    capabilities: {},
    schema: { type: 'object', properties: {}, required: [] },
    async execute(args) {
      const a = args as { idea_id?: string; question: string; estimate_usd: number };
      const row = propose({
        ideaId: a.idea_id ?? null,
        question: a.question,
        estimateUsd: a.estimate_usd,
      });
      return { ok: true, value: `Exploration ${row.id} proposed` };
    },
  };
}

/** One tool call per LLM turn from `calls`, each priced `costUsd`; then plain text. */
function scriptedLLM(calls: Array<Record<string, unknown>>, costUsd = 0) {
  let n = 0;
  const llm: LLMProvider = {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      const call = calls[n++];
      yield {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: costUsd,
        },
      };
      if (!call) {
        yield { type: 'text_delta', text: 'summary: proposed' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      const json = JSON.stringify(call);
      yield { type: 'tool_use_start', toolCallId: `c${n}`, toolName: 'initiative_propose' };
      yield { type: 'tool_use_delta', toolCallId: `c${n}`, partialJson: json };
      yield { type: 'tool_use_end', toolCallId: `c${n}`, inputJson: json };
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
  return { llm, calls: () => n };
}

function build(
  fake: ReturnType<typeof fakeStore>,
  llm: LLMProvider,
  load: () => Promise<{ personalityId: string; file: typeof FILE; sourcePaths: string[] } | null>,
) {
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({ id: 'product-manager', name: 'product-manager' });
  return createInitiativeRunner({
    store: fake.store,
    load,
    buildRegistry: () => {
      const registry = new DefaultToolRegistry();
      registry.register(proposeTool(fake.propose));
      return registry;
    },
    llm,
    safety: createTestSafety(),
    personalities,
    clock: () => new Date('2026-11-28T10:00:00Z'),
  });
}

const ownedWithDayCap = (usdPerDay: number) => async () => ({
  personalityId: 'product-manager',
  file: { ...FILE, budget: { ...FILE.budget, usd_per_day: usdPerDay } },
  sourcePaths: [],
});
const owned = ownedWithDayCap(3);

afterEach(() => vi.restoreAllMocks());

describe('runSurvey', () => {
  it('survey turns seed ideas into proposed explorations', async () => {
    const fake = fakeStore({ seedIdeas: ['onboarding checklist', 'invite flow'] });
    const { llm } = scriptedLLM([
      {
        idea_id: 'IDEA-1',
        question: 'Does a checklist lift activation?',
        estimate_usd: 0.4,
        days: 3,
      },
      { idea_id: 'IDEA-2', question: 'Where do invites drop?', estimate_usd: 0.3, days: 3 },
      { question: 'Which step has the longest wait?', estimate_usd: 0.2, days: 2 },
      { question: 'Do trial users reach a second session?', estimate_usd: 0.2, days: 2 },
    ]);
    const report = await build(fake, llm, owned).runSurvey(FILE.id);

    expect(report.kind).toBe('survey');
    expect(report.endReason).toBe('done');
    expect(report.toolsUsed).toEqual(['initiative_propose']);
    expect(report.proposals).toHaveLength(4);
    expect(report.proposals.every((p) => p.state === 'proposed')).toBe(true);
    expect(fake.explorations.filter((e) => e.ideaId !== null).map((e) => e.ideaId)).toEqual([
      'IDEA-1',
      'IDEA-2',
    ]);
    expect(report.text).toContain('summary');
    expect(fake.windows[0]?.kind).toBe('survey');
    expect(fake.windows[0]?.closed?.endReason).toBe('done');
  });

  it('survey is capped at $1', async () => {
    const fake = fakeStore();
    const many = Array.from({ length: 10 }, (_, i) => ({
      question: `q${i}`,
      estimate_usd: 0.1,
      days: 1,
    }));
    const { llm, calls } = scriptedLLM(many, 0.6);
    const report = await build(fake, llm, ownedWithDayCap(5)).runSurvey(FILE.id);

    // Call 1 leaves $0.40 (above the reserve); call 2 passes the cap and aborts.
    expect(report.endReason).toBe('exploration');
    expect(report.spentUsd).toBeCloseTo(1.2, 5);
    expect(calls()).toBe(2);
    // Charged to the day: the window row carries the spend.
    expect(fake.windows[0]?.closed?.spentUsd).toBeCloseTo(1.2, 5);
  });

  it('survey also stops on the day cap', async () => {
    const fake = fakeStore();
    const { llm, calls } = scriptedLLM([{ question: 'q', estimate_usd: 0.1, days: 1 }], 0.6);
    const report = await build(fake, llm, ownedWithDayCap(0.5)).runSurvey(FILE.id);
    expect(report.endReason).toBe('day');
    expect(calls()).toBe(1);
  });

  it('loop is drained after done', async () => {
    const fake = fakeStore();
    const { llm } = scriptedLLM([{ question: 'q', estimate_usd: 0.1, days: 1 }], 0.6);
    const original = AgentLoop.prototype.run;
    const seen: { it?: AsyncGenerator<unknown>; returns: number } = { returns: 0 };
    vi.spyOn(AgentLoop.prototype, 'run').mockImplementation(function (this: AgentLoop, ...a) {
      const it = original.apply(this, a);
      const ret = it.return.bind(it);
      it.return = (v) => {
        seen.returns++;
        return ret(v);
      };
      seen.it = it;
      return it;
    });
    // $0.6 per call over a $0.5 day cap: the guard aborts, and the run still drains.
    const small = fakeStore();
    await build(small, llm, ownedWithDayCap(0.5)).runSurvey(FILE.id);
    expect(seen.returns).toBe(0);
    expect(await seen.it?.next()).toEqual({ done: true, value: undefined });
    expect(fake.windows).toHaveLength(0);
  });

  it('an unknown initiative raises an EthosError', async () => {
    const fake = fakeStore();
    const { llm } = scriptedLLM([]);
    await expect(build(fake, llm, async () => null).runSurvey('nope')).rejects.toMatchObject({
      name: 'EthosError',
      code: 'INVALID_INPUT',
    });
  });
});

describe('runWindow', () => {
  it('refuses an exploration that is not approved', async () => {
    const fake = fakeStore();
    const row = fake.propose({ ideaId: null, question: 'q', estimateUsd: 0.1 });
    const { llm } = scriptedLLM([]);
    await expect(build(fake, llm, owned).runWindow(FILE.id, row.id)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});
