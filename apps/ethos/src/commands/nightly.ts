// `ethos nightly run [<id>]` (Phase 3c component E) — runs the full
// governed-learning nightly pass on demand, building real per-personality
// dependencies and invoking the @ethosagent/nightly-loop orchestrator.
//
// With an <id>, runs the pass for that one personality. With no id, runs it
// for every user (mutable, non-builtin) personality. Each personality's pass
// is wrapped so one failure prints and the run continues to the next. The
// pass itself is on-demand only — this command adds no cron scheduling and no
// gateway/serve triggers.
//
// Nothing this pass drafts goes live from here (plan `trust-before-reach.md`
// Part 4). The Expression and skill drafts are learning candidates; the
// `replay` step measures pending candidates and `replayAndResolve` is the one
// thing that may promote one without a human.
import { join } from 'node:path';
import { type EthosConfig, resolveLearningReplay } from '@ethosagent/config';
import type { SessionCaseTurn } from '@ethosagent/learning-inbox';
import {
  type ConsolidationInput,
  consolidateMemory,
  type MemoryMeta,
  type NightlyEvidence,
  type NightlyPassDeps,
  type NightlyState,
  parseMemoryMeta,
  runNightlyPass,
} from '@ethosagent/nightly-loop';
import {
  type JudgeResult,
  type ScoreOutcome,
  scorePersonality,
} from '@ethosagent/personality-judge';
import { draftExpressionUpdate, proposeSkillFromEvidence } from '@ethosagent/skill-evolver';
import {
  formatError,
  type LLMProvider,
  type MemoryUpdate,
  type Storage,
  toEthosError,
} from '@ethosagent/types';
import {
  type CaseSessionSource,
  freezeNightlyCases,
  importLegacyLearningQueues,
  learningSubmitPort,
  pendingReplayCandidateIds,
  resolveKanbanDbPath,
  submitExpressionCandidate,
} from '@ethosagent/wiring';
import { createLearningReplayer, createLLM, getStorage } from '../wiring';
import {
  buildEvidenceDigest,
  buildJudgeRunner,
  type EvidenceDigest,
  freezeTargetTurnCases,
  gatherRecentUserPrompts,
  judgeZeroScoredTurns,
  readJudgeStreak,
  signalNotice,
  writeJudgeStreak,
} from './personality-evolve';

function surface(err: unknown): never {
  process.stderr.write(`\n${formatError(toEthosError(err), { color: process.stderr.isTTY })}\n`);
  process.exit(1);
}

// Open `sessions.db` for one read and close it again, as `gatherEvidence` does.
async function withSessionStore<T>(
  ethosDir: string,
  fn: (store: CaseSessionSource) => Promise<T>,
): Promise<T> {
  const { SQLiteSessionStore } = await import('@ethosagent/session-sqlite');
  const store = new SQLiteSessionStore(join(ethosDir, 'sessions.db'));
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

/**
 * `learningReplay.maxCandidatesPerRun` as one budget for the whole run: every
 * personality's `replay` step draws from the same count (L-D9).
 */
function runBudget(max: number): { take(): boolean } {
  let left = max;
  return {
    take() {
      if (left <= 0) return false;
      left -= 1;
      return true;
    },
  };
}

// Read the nightly checkpoint sidecar. Tolerant: a missing or malformed file
// returns null so the pass starts a fresh window rather than crashing.
async function readNightlyState(ethosDir: string, id: string): Promise<NightlyState | null> {
  const path = join(ethosDir, 'personalities', id, '.nightly-state.json');
  const raw = await getStorage().read(path);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'windowEnd' in parsed && 'completed' in parsed) {
      const windowEnd = (parsed as { windowEnd: unknown }).windowEnd;
      const completed = (parsed as { completed: unknown }).completed;
      if (
        typeof windowEnd === 'string' &&
        Array.isArray(completed) &&
        completed.every((c) => typeof c === 'string')
      ) {
        return { windowEnd, completed };
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function writeNightlyState(ethosDir: string, id: string, state: NightlyState): Promise<void> {
  const dir = join(ethosDir, 'personalities', id);
  await getStorage().mkdir(dir);
  await getStorage().writeAtomic(join(dir, '.nightly-state.json'), JSON.stringify(state, null, 2));
}

// Read the importance/decay sidecar (M3, §4.1). Tolerant: a missing or corrupt
// file yields an empty meta so slugs are treated as fresh rather than crashing.
// `memoryRoot`/`storage` come from the configured backend: `~/.ethos` for
// markdown, `<vaultRoot>/<agentDir>` (via its ScopedStorage) for the vault —
// the sidecar lives beside the MEMORY.md it describes.
async function readMemoryMeta(
  memoryRoot: string,
  storage: Storage,
  id: string,
): Promise<MemoryMeta> {
  const path = join(memoryRoot, 'personalities', id, 'memory-meta.json');
  return parseMemoryMeta(await storage.read(path));
}

// Single writer: only the nightly pass persists `memory-meta.json`.
async function writeMemoryMeta(
  memoryRoot: string,
  storage: Storage,
  id: string,
  meta: MemoryMeta,
): Promise<void> {
  const dir = join(memoryRoot, 'personalities', id);
  await storage.mkdir(dir);
  await storage.writeAtomic(join(dir, 'memory-meta.json'), JSON.stringify(meta, null, 2));
}

// Build the real per-personality dependency object the orchestrator drives.
// `llm` and the registry are constructed once by the caller and shared.
function buildDeps(args: {
  config: EthosConfig;
  ethosDir: string;
  reg: import('@ethosagent/personalities').FilePersonalityRegistry;
  llm: LLMProvider;
  memory: import('@ethosagent/types').MemoryProvider;
  /** Backend root for memory files + the `memory-meta.json` sidecar. */
  memoryRoot: string;
  /** Storage confined to the backend (the vault's ScopedStorage under `memory: vault`). */
  memoryStorage: Storage;
  /** Backend history store — records the §5 sidecar reconciliation. */
  history: import('@ethosagent/wiring').HistoryStore;
  /** The run's shared `maxCandidatesPerRun` budget. */
  replayBudget: { take(): boolean };
}): NightlyPassDeps {
  const { config, ethosDir, reg, llm, memory, memoryRoot, memoryStorage, history } = args;
  const learningCtx = { storage: getStorage(), dataDir: ethosDir, personalities: reg };
  const replaySettings = resolveLearningReplay(config);
  // Built on first use: a night with nothing pending never assembles a loop.
  let replayer: Promise<Awaited<ReturnType<typeof createLearningReplayer>>> | undefined;

  // The Judge's writeJudgeStreak needs the JudgeResult, but the orchestrator's
  // dep signature only carries (id, lowStreak). Capture the last scored result
  // in scoreAlignment so writeJudgeStreak can persist it.
  let lastJudgeResult: JudgeResult | null = null;

  // A draft's target cases come from its own evidence (plan
  // `trust-before-reach.md` Part 4, Design §2), recorded per personality as the
  // run produces it: the turns the Judge was shown and the run file it scored
  // them into (Expression), and the messages the digest quoted (skills).
  const judgedTurns = new Map<string, SessionCaseTurn[]>();
  const judgeRunFiles = new Map<string, string>();
  const digests = new Map<string, EvidenceDigest>();

  const memoryCtx = (id: string): import('@ethosagent/types').MemoryContext => ({
    scopeId: `personality:${id}`,
    sessionId: '',
    sessionKey: 'nightly',
    platform: 'cli',
    workingDir: process.cwd(),
  });

  return {
    async readLivingSoul(id) {
      const soul = await reg.readLivingSoul(id);
      return { core: soul.core, expression: soul.expression };
    },

    async gatherEvidence(id): Promise<NightlyEvidence> {
      const { SQLiteSessionStore } = await import('@ethosagent/session-sqlite');
      const store = new SQLiteSessionStore(join(ethosDir, 'sessions.db'));
      try {
        const recent = await gatherRecentUserPrompts(store, id);
        const built = await buildEvidenceDigest(store, id);
        judgedTurns.set(id, recent.turns);
        digests.set(id, built);
        judgeRunFiles.delete(id);
        return {
          recentPrompts: recent.prompts,
          evidenceDigest: built.digest,
          windowStart: recent.windowStart,
          windowEnd: recent.windowEnd,
          elapsedHours: recent.elapsedHours,
        };
      } finally {
        store.close();
      }
    },

    async scoreAlignment(scoreArgs): Promise<ScoreOutcome> {
      const { runner, release, outputPath } = await buildJudgeRunner(
        config,
        scoreArgs.personalityId,
      );
      const judge = reg.get(scoreArgs.personalityId)?.nightly?.judge;
      const outcome = await scorePersonality({
        personalityId: scoreArgs.personalityId,
        core: scoreArgs.core,
        expression: scoreArgs.expression,
        recentPrompts: scoreArgs.evidence.recentPrompts,
        windowStart: scoreArgs.evidence.windowStart,
        windowEnd: scoreArgs.evidence.windowEnd,
        elapsedHours: scoreArgs.evidence.elapsedHours,
        priorLowStreak: scoreArgs.priorLowStreak,
        runner,
        activation: { minInteractions: judge?.minInteractions ?? 20, minElapsedHours: 12 },
      }).finally(release);
      if (outcome.kind === 'scored') {
        lastJudgeResult = outcome.result;
        judgeRunFiles.set(scoreArgs.personalityId, outputPath);
      }
      return outcome;
    },

    readJudgeStreak(id) {
      return readJudgeStreak(id);
    },

    async writeJudgeStreak(id, lowStreak) {
      if (!lastJudgeResult) return;
      await writeJudgeStreak(id, lowStreak, lastJudgeResult);
    },

    draftExpression({ core, currentExpression, evidence }) {
      return draftExpressionUpdate({ core, currentExpression, evidence }, llm);
    },

    // L-D2: a draft is a candidate in every approval mode. Its target cases are
    // the prompts the Judge scored 0 in the run that triggered it — and none
    // when it scored none: a candidate without a target replays `incomplete`
    // and waits for a human, rather than being measured on unrelated turns.
    async submitExpression(id, draft, meta) {
      const runFile = judgeRunFiles.get(id);
      const targetCaseIds = await freezeTargetTurnCases(
        learningCtx,
        id,
        judgeZeroScoredTurns(
          runFile ? await getStorage().read(runFile) : null,
          judgedTurns.get(id) ?? [],
        ),
      );
      const candidate = await submitExpressionCandidate(learningCtx, {
        personalityId: id,
        origin: 'nightly',
        newExpression: draft.newExpression,
        rationale: draft.rationale,
        evidenceRef: meta.evidenceRef,
        targetCaseIds,
      });
      console.log(`  submitted Expression candidate ${candidate.id} for ${id} — waits for replay`);
      return { candidateId: candidate.id };
    },

    async createSkills(id, evidence): Promise<number> {
      const cfg = reg.get(id);
      if (!cfg?.skill_evolution?.enabled) return 0;

      // Target cases are the user turns the evidence digest quoted — the same
      // digest `evidence.evidenceDigest` carries to the drafter.
      const digest = digests.get(id);
      const targetCaseIds = await freezeTargetTurnCases(learningCtx, id, digest?.userTurns ?? []);
      const result = await proposeSkillFromEvidence({
        personalityId: id,
        scope: cfg.skill_evolution?.scope,
        evidenceDigest: evidence.evidenceDigest,
        windowEnd: evidence.windowEnd,
        dataDir: ethosDir,
        llm,
        learning: learningSubmitPort(learningCtx),
        evidenceSessionIds: digest?.sessionIds ?? [],
        targetCaseIds,
      });
      console.log(
        `  skill candidate ${result.candidateId ?? '(none)'}: ${result.decision} — ${result.reason}`,
      );
      return result.decision === 'submitted' ? 1 : 0;
    },

    learning: {
      enabled: replaySettings.enabled,
      budget: args.replayBudget,
      async freezeCases(id) {
        const result = await withSessionStore(ethosDir, (store) =>
          freezeNightlyCases(learningCtx, {
            personalityId: id,
            sessions: store,
            kanbanDbPath: resolveKanbanDbPath({}, ethosDir),
          }),
        );
        return result.frozen.length;
      },
      pendingReplay(id) {
        return pendingReplayCandidateIds(learningCtx, id);
      },
      async replay(_id, candidateId) {
        replayer ??= createLearningReplayer(config, { personalities: reg, actor: 'nightly' });
        const result = await (await replayer)(candidateId);
        console.log(
          `  replayed ${candidateId}: ${result.report.verdict}${
            result.promotion?.ok ? ' — promoted' : ` — ${result.decision.reason ?? 'not promoted'}`
          }`,
        );
        return { verdict: result.report.verdict, promoted: result.promotion?.ok === true };
      },
    },

    async readMemory(id) {
      const snapshot = await memory.prefetch(memoryCtx(id));
      const find = (key: string): string =>
        snapshot?.entries.find((e) => e.key === key)?.content ?? '';
      return { memory: find('MEMORY.md'), user: find('USER.md') };
    },

    consolidate(input: ConsolidationInput) {
      return consolidateMemory(input, llm);
    },

    async applyMemoryUpdates(id, updates: MemoryUpdate[]) {
      await memory.sync(updates, memoryCtx(id));
    },

    readMemoryMeta(id) {
      return readMemoryMeta(memoryRoot, memoryStorage, id);
    },

    writeMemoryMeta(id, meta) {
      return writeMemoryMeta(memoryRoot, memoryStorage, id, meta);
    },

    // §5 sidecar-drift reconciliation: a hand-deleted section was marked
    // 'user-removed' in the sidecar — history-record the transition so the
    // change is auditable even though no memory file's bytes moved.
    async onSidecarReconciled(id, { before, after }) {
      await history.record({
        scopeId: `personality:${id}`,
        key: 'memory-meta.json',
        actions: ['user-removed'],
        source: 'consolidation',
        sessionId: '',
        sessionKey: 'nightly',
        before: JSON.stringify(before, null, 2),
        after: JSON.stringify(after, null, 2),
      });
    },

    // Decay tuning from `memoryConsolidation.*`; undefined → all defaults
    // (30-day half-life, 0.05 threshold, USER.md exempt).
    memoryDecay: config.memoryConsolidation,

    readState(id) {
      return readNightlyState(ethosDir, id);
    },

    writeState(id, state) {
      return writeNightlyState(ethosDir, id, state);
    },

    onSignal(id, signal) {
      console.log(signalNotice(id, signal));
    },

    log(msg) {
      console.log(msg);
    },
  };
}

// Reusable entry shared by the `ethos nightly` CLI command and the
// serve/gateway schedulers. Builds the real per-personality dependencies and
// runs the pass for one id (`opts.id`) or every user personality. Each
// personality's pass is wrapped so one failure prints and the run continues.
export async function runNightlyOnce(config: EthosConfig, opts?: { id?: string }): Promise<void> {
  const id = opts?.id;
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');
  const { ethosDir } = await import('@ethosagent/config');
  const { createMemoryProviderFromConfig } = await import('@ethosagent/wiring');

  const storage = getStorage();
  const dir = ethosDir();
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: dir });
  await reg.loadFromDirectory(join(dir, 'personalities'));

  // The four pre-inbox queues drain into the learning inbox once; a no-op after.
  await importLegacyLearningQueues({
    storage,
    dataDir: dir,
    personalities: reg,
    defaultPersonalityId: config.personality,
  });

  // Resolve targets: the given id, or all user (mutable, non-builtin) ones.
  let targets: string[];
  if (id) {
    const described = reg.describe(id);
    if (!described) {
      console.error(`Unknown personality: ${id}`);
      console.error('Run `ethos personality list` to see available ids.');
      process.exit(1);
    }
    targets = [id];
  } else {
    targets = reg
      .describeAll()
      .filter((d) => !d.builtin)
      .map((d) => d.config.id);
    if (targets.length === 0) {
      console.log('No user personalities to run the nightly pass for.');
      return;
    }
  }

  const llm = await createLLM(config);
  // Consolidation writes are labelled `consolidation` in the provenance
  // history (§2.1). The nightly pass is also the single rotator of the
  // history JSONL (§2.2) — no other process renames it. Backend-aware: under
  // `memory: vault` the provider, history (at `<agentRoot>/.ethos-meta`), and
  // the `memory-meta.json` sidecar all resolve inside the vault, so the pass
  // consolidates the store the agent actually reads from.
  const backend = createMemoryProviderFromConfig({
    config,
    dataDir: dir,
    storage: getStorage(),
    source: 'consolidation',
  });
  const deps = buildDeps({
    config,
    ethosDir: dir,
    reg,
    llm,
    memory: backend.provider,
    memoryRoot: backend.memoryRoot,
    memoryStorage: backend.storage,
    history: backend.history,
    replayBudget: runBudget(resolveLearningReplay(config).maxCandidatesPerRun),
  });

  for (const target of targets) {
    const nightly = reg.get(target)?.nightly;
    // Master nightly toggle: an explicit `false` skips this personality
    // entirely. Absent/undefined runs (today's behavior).
    if (nightly?.enabled === false) {
      console.log(`\n=== Nightly pass: ${target} — skipped (nightly disabled) ===`);
      continue;
    }
    // Per-step gates: judge gated by both the master nightly toggle's judge
    // sub-block and the judge-enabled flag; expression by its own flag. Both
    // default true when absent.
    const gates = {
      judge: nightly?.judge?.enabled !== false,
      expression: nightly?.expression !== false,
    };
    try {
      const result = await runNightlyPass(target, deps, gates);
      console.log(`\n=== Nightly pass: ${target} (window ${result.windowEnd}) ===`);
      for (const step of result.steps) {
        console.log(`  ${step.step.padEnd(12)} ${step.status.padEnd(8)} ${step.detail}`);
      }
      // Single-rotator: roll last month's history out of the live JSONL.
      await backend.history.rotate(`personality:${target}`);
    } catch (err) {
      const e = toEthosError(err);
      console.error(`\n✗ Nightly pass failed for ${target}: ${e.cause}`);
    }
  }
}

export async function runNightly(argv: string[]): Promise<void> {
  const id = argv.find((a) => !a.startsWith('-'));

  try {
    const { readConfig } = await import('@ethosagent/config');
    const { getSecretsResolver } = await import('../wiring');

    const config = await readConfig(getStorage(), await getSecretsResolver());
    if (!config) {
      console.error('Run `ethos setup` first.');
      process.exit(1);
    }

    await runNightlyOnce(config, id ? { id } : {});
  } catch (err) {
    surface(err);
  }
}
