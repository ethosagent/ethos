import { DefaultPersonalityRegistry, DefaultToolRegistry } from '@ethosagent/core';
import {
  type BriefRow,
  canTransition,
  type DraftRow,
  EXPLORATION_TRANSITIONS,
  type ExplorationRow,
  type ExplorationState,
  type FindingRow,
  type IdeaRow,
  type InitiativeRow,
  type InitiativeState,
  type LLMProvider,
  type Tool,
  type WindowKind,
} from '@ethosagent/types';
import { createTestSafety } from '../../../../../packages/core/src/__tests__/helpers/test-safety';
import { type InitiativeFile, InitiativeFileSchema } from '../../config-schema';
import {
  createInitiativeRunner,
  type InitiativeRunner,
  type InitiativeRunnerDeps,
  type LoadedInitiative,
} from '../../runner';

export const NOW = new Date('2026-11-28T10:00:00Z');

/** A valid initiative file; `patch` overrides top-level keys. */
export function makeFile(patch: Record<string, unknown> = {}): InitiativeFile {
  return InitiativeFileSchema.parse({
    id: 'self-serve-activation',
    version: 1,
    origin: 'human',
    created_in: 'chat',
    state: 'active',
    title: 'Self-serve activation',
    outcome: 'More trials reach the first project',
    sources: ['sessions', 'web'],
    autonomy: { mode: 'ask' },
    budget: { usd_per_day: 3, usd_per_exploration: 1, max_open_explorations: 3 },
    timeline: {
      explore_windows: ['every 6h'],
      window_minutes: 20,
      default_days: 7,
      review_on: '2026-12-20',
    },
    delivery: { owner_channel: 'telegram:1', digest_time: '09:00' },
    ...patch,
  });
}

interface FakeWindow {
  id: string;
  initiativeId: string;
  explorationId: string | null;
  kind: WindowKind;
  day: string;
  spentUsd: number;
  endReason: string | null;
}

interface InitiativeMeta {
  createdAt: string;
  lastReactionAt: string | null;
  stopReason: string | null;
}

/** An in-memory ledger with the store's transition rules. Every state change a test asserts goes through it. */
export function fakeLedger() {
  const initiatives = new Map<string, InitiativeRow & InitiativeMeta>();
  const explorations: ExplorationRow[] = [];
  const ideas: IdeaRow[] = [];
  const findings: FindingRow[] = [];
  const briefs: BriefRow[] = [];
  const windows: FakeWindow[] = [];
  const drafts: DraftRow[] = [];
  const caps = new Map<string, number>();
  const transitions: Array<{ id: string; to: string; why: string }> = [];
  const decisions: unknown[] = [];
  const configVersions: unknown[] = [];

  const must = (id: string): ExplorationRow => {
    const e = explorations.find((x) => x.id === id);
    if (!e) throw new Error(`no exploration ${id}`);
    return e;
  };
  const move = (id: string, to: ExplorationState, why: string): void => {
    const e = must(id);
    if (!canTransition(EXPLORATION_TRANSITIONS, e.state, to)) {
      throw new Error(`illegal ${e.state} -> ${to}`);
    }
    e.state = to;
    transitions.push({ id, to, why });
  };

  const ledger = {
    initiatives,
    explorationRows: explorations,
    ideaRows: ideas,
    findings,
    briefs,
    windows,
    draftRows: drafts,
    caps,
    transitions,
    decisions,

    seedInitiative(
      file: InitiativeFile,
      personalityId = 'product-manager',
      meta: Partial<InitiativeMeta> & { state?: InitiativeState } = {},
    ): void {
      initiatives.set(file.id, {
        id: file.id,
        personalityId,
        origin: file.origin,
        parentId: file.parent_id ?? null,
        state: meta.state ?? file.state,
        configPath: `/x/${file.id}.yaml`,
        configHash: 'h',
        version: file.version,
        createdAt: meta.createdAt ?? NOW.toISOString(),
        lastReactionAt: meta.lastReactionAt ?? null,
        stopReason: meta.stopReason ?? null,
      });
      caps.set(file.id, file.budget.usd_per_day);
    },
    seedExploration(e: Partial<ExplorationRow> & { id: string; initiativeId: string }) {
      const row: ExplorationRow = {
        ideaId: null,
        question: 'q',
        state: 'exploring',
        budgetUsd: 0.5,
        spentUsd: 0,
        deadline: '2026-12-05T10:00:00.000Z',
        estimateUsd: 0.5,
        ...e,
      };
      explorations.push(row);
      return row;
    },

    // ---- RunnerStore ----
    openWindow(w: { initiativeId: string; explorationId: string | null; kind: WindowKind }) {
      const id = `W-${windows.length + 1}`;
      windows.push({ id, ...w, day: NOW.toISOString().slice(0, 10), spentUsd: 0, endReason: null });
      return id;
    },
    closeWindow(id: string, r: { spentUsd: number; endReason: string }) {
      const w = windows.find((x) => x.id === id);
      if (!w) throw new Error('no window');
      w.spentUsd = r.spentUsd;
      w.endReason = r.endReason;
      if (w.explorationId) must(w.explorationId).spentUsd += r.spentUsd;
    },
    getInitiative: (id: string) => initiatives.get(id) ?? null,
    getExploration: (id: string) => explorations.find((e) => e.id === id) ?? null,
    explorations: (id: string, states?: ExplorationState[]) =>
      explorations.filter(
        (e) => e.initiativeId === id && (!states?.length || states.includes(e.state)),
      ),
    ideas: (id: string) => ideas.filter((i) => i.initiativeId === id),
    budget(id: string, day: string) {
      const spentUsd = windows
        .filter((w) => w.initiativeId === id && w.day === day)
        .reduce((n, w) => n + w.spentUsd, 0);
      return { spentUsd, capUsd: caps.get(id) ?? 0, explorationsOpen: 0 };
    },
    get(id: string) {
      const initiative = initiatives.get(id);
      if (!initiative) return null;
      const mine = explorations.filter((e) => e.initiativeId === id);
      const ids = new Set(mine.map((e) => e.id));
      return {
        initiative,
        explorations: mine,
        briefs: briefs.filter((b) => ids.has(b.explorationId)),
        findings: findings.filter((f) => ids.has(f.explorationId)),
      };
    },
    transitionExploration: (id: string, to: ExplorationState, why: string) => move(id, to, why),
    extendExploration(id: string, e: { addBudgetUsd: number; deadline: string }) {
      const row = must(id);
      row.budgetUsd = row.spentUsd + e.addBudgetUsd;
      row.deadline = e.deadline;
      return row;
    },
    transitionInitiative(id: string, to: InitiativeState, why: string) {
      const row = initiatives.get(id);
      if (!row) throw new Error(`no initiative ${id}`);
      row.state = to;
      if (to === 'stopped') row.stopReason = why;
      transitions.push({ id, to, why });
    },
    list: (f: { personalityId: string; states?: InitiativeState[] }) =>
      [...initiatives.values()].filter(
        (i) =>
          i.personalityId === f.personalityId && (!f.states?.length || f.states.includes(i.state)),
      ),

    // ---- ledger port (what run tools call) ----
    propose(p: {
      initiativeId: string;
      ideaId: string | null;
      question: string;
      estimateUsd: number;
    }): ExplorationRow {
      const row: ExplorationRow = {
        id: `EXP-${explorations.length + 1}`,
        initiativeId: p.initiativeId,
        ideaId: p.ideaId,
        question: p.question,
        state: 'proposed',
        budgetUsd: p.estimateUsd,
        spentUsd: 0,
        deadline: '2026-12-05T10:00:00.000Z',
        estimateUsd: p.estimateUsd,
      };
      explorations.push(row);
      return row;
    },
    addFinding(f: Omit<FindingRow, 'id' | 'createdAt'>): FindingRow {
      const row = { ...f, id: `F-${findings.length + 1}`, createdAt: 'now' };
      findings.push(row);
      return row;
    },
    submitBrief(b: Omit<BriefRow, 'id' | 'version'>): BriefRow {
      const row = { ...b, id: `B-${briefs.length + 1}`, version: 1 };
      briefs.push(row);
      return row;
    },
    proposeInitiativeDraft(d: { parentId: string; draftYaml: string; why: string }) {
      const row: DraftRow = {
        id: `D-${drafts.length + 1}`,
        parentId: d.parentId,
        draftYaml: d.draftYaml,
        why: d.why,
        status: 'pending',
        refusal: null,
        createdAt: 'now',
      };
      drafts.push(row);
      return { draftId: row.id };
    },

    // ---- written by InitiativeConfigService ----
    configVersions,
    upsertInitiative(row: InitiativeRow) {
      const prev = initiatives.get(row.id);
      initiatives.set(row.id, {
        ...row,
        createdAt: prev?.createdAt ?? NOW.toISOString(),
        lastReactionAt: prev?.lastReactionAt ?? null,
        stopReason: prev?.stopReason ?? null,
      });
    },
    appendConfigVersion(v: unknown) {
      configVersions.push(v);
    },

    // ---- self-start bookkeeping (Task 5.4) ----
    drafts: (status: DraftRow['status']) => drafts.filter((d) => d.status === status),
    settleDraft(id: string, status: 'materialised' | 'refused', refusal: string | null) {
      const d = drafts.find((x) => x.id === id);
      if (d?.status !== 'pending') return;
      d.status = status;
      d.refusal = refusal;
    },
    reactionClock(id: string) {
      const i = initiatives.get(id);
      return i
        ? { createdAt: i.createdAt, lastReactionAt: i.lastReactionAt, stopReason: i.stopReason }
        : null;
    },
  };
  return ledger;
}

export type FakeLedger = ReturnType<typeof fakeLedger>;

/** One scripted tool call; `name` is any tool the run registry has. */
export interface Step {
  name: string;
  input: Record<string, unknown>;
}

/** One LLM turn per entry (a turn may hold several calls), each priced `costUsd`; then plain text. */
export function scriptedLLM(turns: Step[][], costUsd = 0.1) {
  let n = 0;
  const prompts: string[] = [];
  const llm: LLMProvider = {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(msgs: unknown): AsyncIterable<import('@ethosagent/types').CompletionChunk> {
      prompts.push(JSON.stringify(msgs));
      const calls = turns[n++] ?? [];
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
      if (calls.length === 0) {
        yield { type: 'text_delta', text: 'summary' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      for (const [i, c] of calls.entries()) {
        const json = JSON.stringify(c.input);
        const id = `c${n}-${i}`;
        yield { type: 'tool_use_start', toolCallId: id, toolName: c.name };
        yield { type: 'tool_use_delta', toolCallId: id, partialJson: json };
        yield { type: 'tool_use_end', toolCallId: id, inputJson: json };
      }
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
  return { llm, calls: () => n, prompts };
}

function tool(name: string, run: (a: Record<string, unknown>) => string): Tool {
  return {
    name,
    description: name,
    toolset: 'initiative',
    capabilities: {},
    schema: { type: 'object', properties: {}, required: [] },
    async execute(args) {
      return { ok: true, value: run(args as Record<string, unknown>) };
    },
  };
}

/** The three ledger tools a run uses, over the fake ledger, bound to one initiative. */
export function ledgerTools(ledger: FakeLedger, initiativeId: string): Tool[] {
  return [
    tool('initiative_propose', (a) => {
      if (a.kind === 'new_initiative') {
        const { draftId } = ledger.proposeInitiativeDraft({
          parentId: initiativeId,
          draftYaml: String(a.draft_yaml),
          why: String(a.why),
        });
        return `Draft ${draftId} proposed`;
      }
      const row = ledger.propose({
        initiativeId,
        ideaId: typeof a.idea_id === 'string' ? a.idea_id : null,
        question: String(a.question),
        estimateUsd: Number(a.estimate_usd),
      });
      return `Exploration ${row.id} proposed`;
    }),
    tool('initiative_note', (a) => {
      const f = ledger.addFinding({
        explorationId: String(a.exploration_id),
        claim: String(a.claim),
        sourceRef: String(a.source_ref),
        confidence: Number(a.confidence),
      });
      return `Finding ${f.id}`;
    }),
    tool('initiative_brief', (a) => {
      const b = ledger.submitBrief({
        explorationId: String(a.exploration_id),
        bodyMd: String(a.recommendation ?? ''),
        recommendedOption: String(a.recommendation ?? ''),
        partial: a.partial === true,
      });
      return `Brief ${b.id}`;
    }),
  ];
}

export interface Harness {
  runner: InitiativeRunner;
  ledger: FakeLedger;
}

/** A runner over the fake ledger. `files` maps initiative id to its (already clamped) file. */
export function harness(opts: {
  ledger: FakeLedger;
  llm: LLMProvider;
  files: Record<string, InitiativeFile>;
  extra?: Partial<InitiativeRunnerDeps>;
  personalityIds?: string[];
}): InitiativeRunner {
  const personalities = new DefaultPersonalityRegistry();
  for (const id of opts.personalityIds ?? ['product-manager']) {
    personalities.define({ id, name: id });
  }
  return createInitiativeRunner({
    store: opts.ledger,
    load: async (id): Promise<LoadedInitiative | null> => {
      const file = opts.files[id];
      const row = opts.ledger.initiatives.get(id);
      if (!file || !row) return null;
      opts.ledger.caps.set(id, file.budget.usd_per_day);
      return { personalityId: row.personalityId, file, sourcePaths: [] };
    },
    buildRegistry: ({ initiativeId }) => {
      const registry = new DefaultToolRegistry();
      for (const t of ledgerTools(opts.ledger, initiativeId)) registry.register(t);
      return registry;
    },
    llm: opts.llm,
    safety: createTestSafety(),
    personalities,
    clock: () => NOW,
    ...opts.extra,
  });
}
