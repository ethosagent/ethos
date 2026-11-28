import { DefaultPersonalityRegistry, type DefaultToolRegistry } from '@ethosagent/core';
import { estimateCost } from '@ethosagent/pricing';
import {
  type AgentEvent,
  type AgentSafety,
  EthosError,
  type ExplorationRow,
  type FindingRow,
  type IdeaRow,
  type InitiativeStore,
  type LLMProvider,
  type PersonalityRegistry,
  type WindowKind,
} from '@ethosagent/types';
import { createWindowGuard } from './budget';
import type { InitiativeFile } from './config-schema';
import { surveyPrompt, windowPrompt } from './prompts';
import { createReadOnlyLoop, createReadOnlyLoopParts, readOnlyRunOptions } from './run-loop';
import { INITIATIVE_READ_TOOLS, runToolNames } from './tool-classes';

/** A survey is charged to the day but never costs more than this. */
export const SURVEY_CAP_USD = 1;
/** Abort when a cap has less than this left: the in-flight call finishes, so overshoot is at most one call (R10). */
export const PER_CALL_RESERVE_USD = 0.05;

/** What a run calls on the store. A subset of the contract; no decision writer, no config writer. */
export type RunnerStore = Pick<
  InitiativeStore,
  'openWindow' | 'closeWindow' | 'getExploration' | 'explorations' | 'ideas' | 'budget' | 'get'
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
  }): DefaultToolRegistry;
  llm: LLMProvider;
  safety: AgentSafety;
  /** Must resolve the owner's personality. */
  personalities: PersonalityRegistry;
  clock?: () => Date;
  model?: string;
  onError?: (err: unknown) => void;
}

export interface RunReport {
  windowId: string;
  kind: WindowKind;
  initiativeId: string;
  explorationId: string | null;
  spentUsd: number;
  /** 'done', 'day' or 'exploration' (a cap), or 'error'. */
  endReason: string;
  toolsUsed: string[];
  reads: string[];
  proposals: ExplorationRow[];
  ideas: IdeaRow[];
  findings: FindingRow[];
  text: string;
  error?: string;
}

export interface InitiativeRunner {
  runSurvey(initiativeId: string): Promise<RunReport>;
  runWindow(initiativeId: string, explorationId: string): Promise<RunReport>;
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

  async function run(input: {
    initiativeId: string;
    kind: 'survey' | 'window';
    exploration: ExplorationRow | null;
  }): Promise<RunReport> {
    const loaded = await deps.load(input.initiativeId);
    if (!loaded) throw notFound(input.initiativeId);
    const { personalityId, file, sourcePaths } = loaded;
    const { initiativeId } = input;
    const personality = deps.personalities.get(personalityId);
    if (!personality) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `initiative "${initiativeId}" belongs to unknown personality "${personalityId}"`,
        action: 'Restore the personality or pause the initiative.',
      });
    }

    const day = now().toISOString().slice(0, 10);
    const budget = deps.store.budget(initiativeId, day);
    const explorationRemainingUsd = input.exploration
      ? input.exploration.budgetUsd - input.exploration.spentUsd
      : SURVEY_CAP_USD;
    const abort = new AbortController();
    const guard = createWindowGuard(
      {
        // One source: the store's cap (`capFor`, bound by wiring to the clamped `usd_per_day`).
        dayRemainingUsd: Math.max(0, budget.capUsd - budget.spentUsd),
        explorationRemainingUsd,
        perCallReserveUsd: PER_CALL_RESERVE_USD,
      },
      abort,
    );

    const before = {
      explorations: new Set(deps.store.explorations(initiativeId).map((e) => e.id)),
      ideas: new Set(deps.store.ideas(initiativeId).map((i) => i.id)),
      findings: new Set((deps.store.get(initiativeId)?.findings ?? []).map((f) => f.id)),
    };
    const promptInput = {
      file,
      ideas: deps.store.ideas(initiativeId),
      explorations: deps.store.explorations(initiativeId),
    };
    const prompt = input.exploration
      ? windowPrompt({ ...promptInput, exploration: input.exploration })
      : surveyPrompt(promptInput);

    const registry = deps.buildRegistry({ initiativeId, personalityId, sourcePaths });
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
      explorationId: input.exploration?.id ?? null,
      kind: input.kind,
    });

    const tools = new Set<string>();
    const reads: string[] = [];
    let text = '';
    let error: string | undefined;
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
          const priced =
            e.estimatedCostUsd > 0
              ? e.estimatedCostUsd
              : estimateCost(pricedModel, {
                  inputTokens: e.inputTokens,
                  outputTokens: e.outputTokens,
                }).costUsd;
          guard.onUsage(priced);
        } else if (e.type === 'error') {
          error = `${e.code}: ${e.error}`;
        }
      }
    } catch (err) {
      deps.onError?.(err);
      error = err instanceof Error ? err.message : String(err);
    }
    // A cap abort ends the run with an empty-completion error event; the cap is the reason.
    const endReason = guard.endReason() ?? (error ? 'error' : 'done');

    deps.store.closeWindow(windowId, {
      spentUsd: guard.spentUsd(),
      toolsUsed: [...tools].sort(),
      reads,
      checkpoint: null,
      endReason,
    });

    return {
      windowId,
      kind: input.kind,
      initiativeId,
      explorationId: input.exploration?.id ?? null,
      spentUsd: guard.spentUsd(),
      endReason,
      toolsUsed: [...tools].sort(),
      reads,
      proposals: deps.store
        .explorations(initiativeId)
        .filter((x) => !before.explorations.has(x.id)),
      ideas: deps.store.ideas(initiativeId).filter((x) => !before.ideas.has(x.id)),
      findings: (deps.store.get(initiativeId)?.findings ?? []).filter(
        (f) => !before.findings.has(f.id),
      ),
      text,
      ...(error ? { error } : {}),
    };
  }

  return {
    runSurvey: (initiativeId) => run({ initiativeId, kind: 'survey', exploration: null }),
    async runWindow(initiativeId, explorationId) {
      const exploration = deps.store.getExploration(explorationId);
      if (!exploration || exploration.initiativeId !== initiativeId) {
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: `exploration "${explorationId}" is not part of initiative "${initiativeId}"`,
          action: 'Pass an exploration id the initiative owns.',
        });
      }
      if (exploration.state !== 'exploring') {
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: `exploration "${explorationId}" is ${exploration.state}, not exploring`,
          action: 'Approve the proposal first; a run never approves its own work.',
        });
      }
      return run({ initiativeId, kind: 'window', exploration });
    },
  };
}

function collect(e: AgentEvent, text: string): string {
  if (e.type === 'text_delta') return text + e.text;
  if (e.type === 'done') return e.text || text;
  return text;
}
