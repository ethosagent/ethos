import { DefaultPersonalityRegistry, type DefaultToolRegistry } from '@ethosagent/core';
import { estimateCost } from '@ethosagent/pricing';
import {
  type AgentEvent,
  type AgentSafety,
  type Constitution,
  EthosError,
  type ExplorationRow,
  type FindingRow,
  type IdeaRow,
  type InitiativeStore,
  type LLMProvider,
  type PersonalityRegistry,
  type WindowKind,
} from '@ethosagent/types';
import {
  type AutonomyOutcome,
  applyAutonomy,
  BRIEF_RESERVE_SHARE,
  partialBrief,
  prepareWindow,
  settleWindow,
  type WindowOutcome,
} from './autonomy';
import { createWindowGuard } from './budget';
import type { InitiativeFile } from './config-schema';
import { createKeyedLock, totalsRemainingUsd } from './day-caps';
import { briefWindowPrompt, scanPrompt, surveyPrompt, windowPrompt } from './prompts';
import { createReadOnlyLoop, createReadOnlyLoopParts, readOnlyRunOptions } from './run-loop';
import {
  createSelfStart,
  type DraftOutcome,
  SCAN_CAP_USD,
  type SelfStart,
  type SelfStartDeps,
} from './self-start';
import { INITIATIVE_READ_TOOLS, runToolNames } from './tool-classes';

/** A survey is charged to the day but never costs more than this. */
export const SURVEY_CAP_USD = 1;
/** Abort when a cap has less than this left: the in-flight call finishes, so overshoot is at most one call (R10). */
export const PER_CALL_RESERVE_USD = 0.05;

/** What a run calls on the store. A subset of the contract; no decision writer, no config writer. */
export type RunnerStore = Pick<
  InitiativeStore,
  | 'openWindow'
  | 'closeWindow'
  | 'getInitiative'
  | 'getExploration'
  | 'explorations'
  | 'ideas'
  | 'budget'
  | 'get'
  | 'transitionExploration'
  | 'submitBrief'
  | 'list'
>;

/** An initiative as the runner needs it: the owner, the validated YAML and the readable source paths. */
export interface LoadedInitiative {
  personalityId: string;
  file: InitiativeFile;
  sourcePaths: string[];
}

export interface InitiativeRunnerDeps {
  store: RunnerStore;
  /** Reads and validates one initiative; null when the id is unknown. Wiring owns the YAML read. */
  load(initiativeId: string): Promise<LoadedInitiative | null>;
  /** A fresh read-only registry (L2, L3) for this run. */
  buildRegistry(input: {
    initiativeId: string;
    personalityId: string;
    sourcePaths: readonly string[];
    /** The exploration of an exploration or brief window; its note and brief tools write only there. */
    explorationId?: string;
  }): DefaultToolRegistry;
  llm: LLMProvider;
  safety: AgentSafety;
  /** Must resolve the owner's personality. */
  personalities: PersonalityRegistry;
  clock?: () => Date;
  /**
   * The constitution, for the operator's day totals (`maxUsdPerDay`, `maxUsdPerDayPerPersonality`),
   * summed across initiatives at run start (day-caps.ts). Falls back to `selfStart.constitution`;
   * with neither, no total is enforced.
   */
  constitution?: () => Promise<Constitution>;
  model?: string;
  onError?: (err: unknown) => void;
  /**
   * Agent-started initiatives (Task 5.4): the config service that saves them, the settings and
   * constitution they obey, and the store reads they need. Without it a scan still runs but its
   * drafts stay pending (suggestions), no pool is enforced and nothing auto-pauses.
   */
  selfStart?: Omit<SelfStartDeps, 'load' | 'now' | 'personalityIds' | 'onError'>;
}

export interface RunReport {
  windowId: string;
  kind: WindowKind;
  initiativeId: string;
  explorationId: string | null;
  spentUsd: number;
  /** 'done', 'day', 'window' or 'exploration' (a cap), or 'error'. */
  endReason: string;
  toolsUsed: string[];
  reads: string[];
  proposals: ExplorationRow[];
  ideas: IdeaRow[];
  findings: FindingRow[];
  text: string;
  /** Proposals the initiative's autonomy started (proposed -> exploring), with the reason. */
  started: AutonomyOutcome['started'];
  /** Proposals still waiting for a Gate 1 decision, with the reason. */
  waiting: AutonomyOutcome['waiting'];
  /** Where a window left its exploration; null for a survey. */
  outcome: WindowOutcome | null;
  /** Scan only: what became of each pending draft after the run (materialised, refused, suggested). */
  drafts: DraftOutcome[];
  error?: string;
}

export interface InitiativeRunner {
  runSurvey(initiativeId: string): Promise<RunReport>;
  /** Looks for topics worth their own initiative; its drafts are materialised after the run. */
  runScan(initiativeId: string): Promise<RunReport>;
  /** Materialises pending drafts now (the scan does it after its own run). */
  materialiseDrafts(): Promise<DraftOutcome[]>;
  /** Pauses every self-started initiative with no owner reaction for 14 days; returns their ids. */
  pauseIdle(): string[];
  /**
   * `capUsd` is the window's own cap, `planDay`'s `perWindowUsd`; the window also holds the brief
   * reserve back from the day so a stalled exploration can still hand in a partial brief.
   */
  runWindow(
    initiativeId: string,
    explorationId: string,
    opts?: { capUsd?: number },
  ): Promise<RunReport>;
}

const READ_ARG_KEYS = ['path', 'url', 'query', 'pattern', 'task_id', 'id'] as const;
const READ_TOOL_SET: ReadonlySet<string> = new Set(INITIATIVE_READ_TOOLS);

function readRef(toolName: string, args: unknown): string | null {
  if (!READ_TOOL_SET.has(toolName)) return null;
  if (typeof args === 'object' && args !== null) {
    const rec = args as Record<string, unknown>;
    for (const key of READ_ARG_KEYS) {
      const v = rec[key];
      if (typeof v === 'string' && v) return `${toolName}: ${v.slice(0, 200)}`;
    }
  }
  return toolName;
}

function notFound(initiativeId: string): EthosError {
  return new EthosError({
    code: 'INVALID_INPUT',
    cause: `unknown initiative "${initiativeId}"`,
    action: 'Run "ethos initiatives run" with an id from your initiatives/ folder.',
  });
}

export function createInitiativeRunner(deps: InitiativeRunnerDeps): InitiativeRunner {
  const now = deps.clock ?? (() => new Date());
  const pricedModel = deps.model ?? deps.llm.model;
  const selfStart: SelfStart | undefined = deps.selfStart
    ? createSelfStart({
        ...deps.selfStart,
        load: async (id) => deps.load(id),
        now,
        personalityIds: () => deps.personalities.list().map((p) => p.id),
        ...(deps.onError ? { onError: deps.onError } : {}),
      })
    : undefined;
  const locks = createKeyedLock();
  const readConstitution = deps.constitution ?? deps.selfStart?.constitution;
  const materialise = async (): Promise<DraftOutcome[]> => selfStart?.materialiseDrafts() ?? [];

  async function run(input: {
    initiativeId: string;
    kind: 'survey' | 'window' | 'scan';
    exploration: ExplorationRow | null;
    capUsd?: number;
  }): Promise<RunReport> {
    const loaded = await deps.load(input.initiativeId);
    if (!loaded) throw notFound(input.initiativeId);
    const { file } = loaded;
    const { initiativeId } = input;
    // Remaining money is read once and spent only when the window closes, so runs that share a
    // cap run one at a time in this process: the initiative's own, the agent pool, and (when the
    // constitution sets a total) the day totals. Cross-process stays a limitation (day-caps.ts).
    const c = (await readConstitution?.())?.initiatives;
    const keys = [
      `i:${initiativeId}`,
      ...(file.origin === 'agent' ? ['pool'] : []),
      ...(c?.maxUsdPerDay !== undefined || c?.maxUsdPerDayPerPersonality !== undefined
        ? ['totals']
        : []),
    ];
    return locks.run(keys, () => runLocked(input, loaded, c));
  }

  async function runLocked(
    input: {
      initiativeId: string;
      kind: 'survey' | 'window' | 'scan';
      exploration: ExplorationRow | null;
      capUsd?: number;
    },
    loaded: LoadedInitiative,
    constitution: Constitution['initiatives'],
  ): Promise<RunReport> {
    const { personalityId, file, sourcePaths } = loaded;
    const { initiativeId } = input;
    const idle = selfStart?.pauseIfIdle(initiativeId) ?? null;
    if (idle !== null) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `initiative "${initiativeId}" was ${idle}`,
        action: 'React to it (keep, make mine or stop) or resume it; a run never resumes one.',
      });
    }
    const row = deps.store.getInitiative(initiativeId);
    if (row?.state !== 'active' && row?.state !== 'self_started') {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `initiative "${initiativeId}" is ${row?.state ?? 'unknown'}, so it does not run`,
        action: 'Resume the initiative first (an owner step); a run never resumes one.',
      });
    }
    const personality = deps.personalities.get(personalityId);
    if (!personality) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `initiative "${initiativeId}" belongs to unknown personality "${personalityId}"`,
        action: 'Restore the personality or pause the initiative.',
      });
    }

    // A stalled exploration gets a brief window; an exhausted one a dig-deeper budget (autonomy.ts).
    const prepared = input.exploration
      ? prepareWindow(deps.store, input.exploration, now(), PER_CALL_RESERVE_USD)
      : null;
    const exploration = prepared?.exploration ?? null;
    const kind: WindowKind = prepared ? prepared.kind : input.kind;

    const day = now().toISOString().slice(0, 10);
    const budget = deps.store.budget(initiativeId, day);
    // An agent initiative also draws on the shared pool: the day's pool total (every agent
    // initiative's spend so far) caps it beside its own cap. A human initiative's budget is
    // never touched: each initiative's spend is its own windows.
    const poolLeft =
      file.origin === 'agent' && selfStart
        ? await selfStart.poolRemainingTodayUsd(day)
        : Number.POSITIVE_INFINITY;
    const explorationRemainingUsd = exploration
      ? kind === 'brief'
        ? file.budget.usd_per_day * BRIEF_RESERVE_SHARE
        : exploration.budgetUsd - exploration.spentUsd
      : input.kind === 'scan'
        ? SCAN_CAP_USD
        : SURVEY_CAP_USD;
    // The operator's day totals across every initiative (day-caps.ts); the YAML clamp is per initiative.
    const totalsLeft = totalsRemainingUsd({
      store: deps.store,
      constitution,
      personalityId,
      personalityIds: deps.personalities.list().map((p) => p.id),
      day,
    });
    const abort = new AbortController();
    const guard = createWindowGuard(
      {
        // One source: the store's cap (`capFor`, bound by wiring to the clamped `usd_per_day`).
        dayRemainingUsd: Math.max(
          0,
          Math.min(budget.capUsd - budget.spentUsd, poolLeft, totalsLeft),
        ),
        explorationRemainingUsd,
        perCallReserveUsd: PER_CALL_RESERVE_USD,
        ...(kind === 'window'
          ? { briefReserveUsd: file.budget.usd_per_day * BRIEF_RESERVE_SHARE }
          : {}),
        ...(input.capUsd !== undefined ? { windowCapUsd: input.capUsd } : {}),
      },
      abort,
    );

    const before = {
      explorations: new Set(deps.store.explorations(initiativeId).map((e) => e.id)),
      ideas: new Set(deps.store.ideas(initiativeId).map((i) => i.id)),
      findings: new Set((deps.store.get(initiativeId)?.findings ?? []).map((f) => f.id)),
      briefs: new Set((deps.store.get(initiativeId)?.briefs ?? []).map((b) => b.id)),
    };
    const promptInput = {
      file,
      ideas: deps.store.ideas(initiativeId),
      explorations: deps.store.explorations(initiativeId),
    };
    const prompt = exploration
      ? kind === 'brief'
        ? briefWindowPrompt({
            ...promptInput,
            exploration,
            findings: (deps.store.get(initiativeId)?.findings ?? []).filter(
              (f) => f.explorationId === exploration.id,
            ),
          })
        : windowPrompt({ ...promptInput, exploration })
      : input.kind === 'scan'
        ? scanPrompt({
            file,
            explorations: promptInput.explorations,
            pending: (deps.selfStart?.store.drafts('pending') ?? [])
              .filter((d) => d.parentId === initiativeId)
              .map((d) => `- ${d.id}: ${d.why}`),
          })
        : surveyPrompt(promptInput);

    const registry = deps.buildRegistry({
      initiativeId,
      personalityId,
      sourcePaths,
      ...(exploration ? { explorationId: exploration.id } : {}),
    });
    // The registry layer rejects any tool outside `personality.toolset`, and a personality's own
    // toolset names no `initiative_*` tool. The run sees the owner with exactly the run tools
    // (L1: the read allowlist narrowed by its toolset, plus the ledger tools); nothing is added.
    const runToolset = runToolNames(personality.toolset);
    const runPersonalities = new DefaultPersonalityRegistry();
    runPersonalities.define({ ...personality, toolset: runToolset });
    const loop = createReadOnlyLoop(
      createReadOnlyLoopParts({
        tools: registry,
        llm: deps.llm,
        safety: deps.safety,
        personalities: runPersonalities,
        allowed: new Set(runToolset),
      }),
    );
    const windowId = deps.store.openWindow({
      initiativeId,
      explorationId: exploration?.id ?? null,
      kind,
    });

    // Limitation (no enforcer): only LLM `usage` events are metered. Tools that bill per call
    // (engine_ask, x_search, search providers) report no cost in `ToolResult`, and the run loop
    // has no usage recorder seam for them, so their spend is not charged to the window or the
    // day. A run's tool calls are bounded by the loop's per-turn tool budget, not by dollars.
    const tools = new Set<string>();
    const reads: string[] = [];
    let text = '';
    let error: string | undefined;
    let unpriced = false;
    try {
      // Drain to exhaustion: `done` is the answer, not the end of the turn. After an
      // abort the loop keeps running to its own end, so nothing is cut mid-write.
      for await (const e of loop.run(prompt, {
        ...readOnlyRunOptions({
          personalityId,
          initiativeId,
          windowId,
          abortSignal: abort.signal,
          ...(deps.model ? { model: deps.model } : {}),
        }),
        // Stated here as well so the audience census sees it at the call site.
        roomAudience: 'private',
      })) {
        text = collect(e, text);
        if (e.type === 'tool_start') {
          tools.add(e.toolName);
          const ref = readRef(e.toolName, e.args);
          if (ref && !reads.includes(ref)) reads.push(ref);
        } else if (e.type === 'usage') {
          // A reported cost wins. Otherwise the table prices it, cache buckets included. A model
          // with no price row is NOT free: its cost is unknowable, so it exhausts the guard
          // (budget.ts treats a non-finite cost as a stop) rather than running uncapped.
          let priced = e.estimatedCostUsd;
          if (!(priced > 0)) {
            const est = estimateCost(pricedModel, {
              inputTokens: e.inputTokens,
              outputTokens: e.outputTokens,
              ...(e.cacheReadTokens !== undefined ? { cacheReadTokens: e.cacheReadTokens } : {}),
              ...(e.cacheCreationTokens !== undefined
                ? { cacheCreationTokens: e.cacheCreationTokens }
                : {}),
            });
            if (est.basis === 'unknown') {
              priced = Number.NaN;
              unpriced = true;
            } else priced = est.costUsd;
          }
          guard.onUsage(priced);
        } else if (e.type === 'error') {
          error = `${e.code}: ${e.error}`;
        }
      }
    } catch (err) {
      deps.onError?.(err);
      error = err instanceof Error ? err.message : String(err);
    }
    // The abort surfaces as an empty-completion error; the real reason is the missing price.
    if (unpriced) error = `unpriced model "${pricedModel}": stopped, its cost cannot be capped`;
    // A cap abort ends the run with an empty-completion error event; the cap is the reason.
    const endReason = guard.endReason() ?? (error ? 'error' : 'done');

    deps.store.closeWindow(windowId, {
      spentUsd: guard.spentUsd(),
      toolsUsed: [...tools].sort(),
      reads,
      checkpoint: null,
      endReason,
    });

    const after = {
      proposals: deps.store
        .explorations(initiativeId)
        .filter((x) => !before.explorations.has(x.id)),
      briefs: (deps.store.get(initiativeId)?.briefs ?? []).filter((b) => !before.briefs.has(b.id)),
    };
    // One brief window per stall: if it ended without a partial brief (a day-cap stop, an error,
    // or a brief that claimed to be complete), the runner hands in its own from the findings, so
    // a stalled exploration never stops silently and never waits for a second brief window.
    if (exploration && kind === 'brief' && !after.briefs.some((b) => b.partial)) {
      const own = (deps.store.get(initiativeId)?.findings ?? []).filter(
        (f) => f.explorationId === exploration.id,
      );
      after.briefs.push(
        deps.store.submitBrief(
          partialBrief(deps.store.getExploration(exploration.id) ?? exploration, own),
        ),
      );
    }
    // Autonomy and stalls are the runner's own moves, applied after the window is closed and
    // charged. They are plain transitions, never decision rows (autonomy.ts).
    const autonomy = applyAutonomy(deps.store, file, after.proposals);
    // The run has ended and its window is closed; only now do the drafts it left become files.
    const drafts = input.kind === 'scan' ? await materialise() : [];
    const outcome = exploration
      ? settleWindow(
          deps.store,
          exploration.id,
          after.briefs.filter((b) => b.explorationId === exploration.id),
          now(),
          PER_CALL_RESERVE_USD,
        )
      : null;

    return {
      windowId,
      kind,
      initiativeId,
      explorationId: exploration?.id ?? null,
      spentUsd: guard.spentUsd(),
      endReason,
      toolsUsed: [...tools].sort(),
      reads,
      proposals: after.proposals,
      ideas: deps.store.ideas(initiativeId).filter((x) => !before.ideas.has(x.id)),
      findings: (deps.store.get(initiativeId)?.findings ?? []).filter(
        (f) => !before.findings.has(f.id),
      ),
      text,
      started: autonomy.started,
      waiting: autonomy.waiting,
      outcome,
      drafts,
      ...(error ? { error } : {}),
    };
  }

  return {
    runSurvey: (initiativeId) => run({ initiativeId, kind: 'survey', exploration: null }),
    runScan: (initiativeId) => run({ initiativeId, kind: 'scan', exploration: null }),
    materialiseDrafts: materialise,
    pauseIdle: () => selfStart?.pauseIdle() ?? [],
    async runWindow(initiativeId, explorationId, opts) {
      const exploration = deps.store.getExploration(explorationId);
      if (!exploration || exploration.initiativeId !== initiativeId) {
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: `exploration "${explorationId}" is not part of initiative "${initiativeId}"`,
          action: 'Pass an exploration id the initiative owns.',
        });
      }
      if (exploration.state !== 'exploring' && exploration.state !== 'stalled') {
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: `exploration "${explorationId}" is ${exploration.state}, not exploring or stalled`,
          action: 'Approve the proposal first; a run never approves its own work.',
        });
      }
      return run({
        initiativeId,
        kind: 'window',
        exploration,
        ...(opts?.capUsd !== undefined ? { capUsd: opts.capUsd } : {}),
      });
    },
  };
}

function collect(e: AgentEvent, text: string): string {
  if (e.type === 'text_delta') return text + e.text;
  if (e.type === 'done') return e.text || text;
  return text;
}
