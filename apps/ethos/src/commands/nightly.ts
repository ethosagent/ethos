// `ethos nightly run [<id>]` (Phase 3c component E) — runs the full
// governed-learning nightly pass on demand, building real per-personality
// dependencies and invoking the @ethosagent/nightly-loop orchestrator.
//
// With an <id>, runs the pass for that one personality. With no id, runs it
// for every user (mutable, non-builtin) personality. Each personality's pass
// is wrapped so one failure prints and the run continues to the next. The
// pass itself is on-demand only — this command adds no cron scheduling and no
// gateway/serve triggers.
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
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
import { createLLM, getStorage } from '../wiring';
import {
  buildEvidenceDigest,
  buildJudgeRunner,
  gatherRecentUserPrompts,
  readJudgeStreak,
  signalNotice,
  writeJudgeStreak,
} from './personality-evolve';

function surface(err: unknown): never {
  process.stderr.write(`\n${formatError(toEthosError(err), { color: process.stderr.isTTY })}\n`);
  process.exit(1);
}

// Auto-mode proposal test for a drafted skill candidate. Asks the LLM whether
// the candidate is a genuine, reusable skill (PASS) or noise (FAIL). Any error
// or ambiguous reply is treated as FAIL — auto-promotion is fail-closed.
async function judgeSkillCandidate(content: string, llm: LLMProvider): Promise<boolean> {
  const prompt = [
    'You are reviewing a proposed agent skill before it is added to the active skill set.',
    'A good skill is a generalizable, reusable approach — not a one-off fact or a restated task.',
    '',
    '## Candidate skill',
    content.trim(),
    '',
    'Reply with exactly PASS if this is a genuine, reusable skill worth keeping, or FAIL otherwise.',
  ].join('\n');

  let text = '';
  for await (const chunk of llm.complete([{ role: 'user', content: prompt }], [], {
    maxTokens: 16,
    temperature: 0,
  })) {
    if (chunk.type === 'text_delta') text += chunk.text;
  }
  return text.trim().toUpperCase().startsWith('PASS');
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
}): NightlyPassDeps {
  const { config, ethosDir, reg, llm, memory, memoryRoot, memoryStorage, history } = args;

  // The Judge's writeJudgeStreak needs the JudgeResult, but the orchestrator's
  // dep signature only carries (id, lowStreak). Capture the last scored result
  // in scoreAlignment so writeJudgeStreak can persist it.
  let lastJudgeResult: JudgeResult | null = null;

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
      const runner = await buildJudgeRunner(config, scoreArgs.personalityId);
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
      });
      if (outcome.kind === 'scored') lastJudgeResult = outcome.result;
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

    async applyExpression(id, newExpression, opts) {
      const { entry } = await reg.evolveExpression(id, newExpression, opts);
      return { revisionId: entry.revisionId };
    },

    async createSkills(id, evidence): Promise<number> {
      const cfg = reg.get(id);
      if (!cfg?.skill_evolution?.enabled) return 0;

      const result = await proposeSkillFromEvidence({
        personalityId: id,
        approvalMode: cfg.evolution_approval_mode,
        promotion: cfg.skill_evolution?.promotion,
        scope: cfg.skill_evolution?.scope,
        evidenceDigest: evidence.evidenceDigest,
        windowEnd: evidence.windowEnd,
        dataDir: ethosDir,
        storage: getStorage(),
        llm,
        // Auto-mode proposal test: a candidate is promoted only if this LLM
        // review judges it a genuine, reusable skill. This is the nightly-pass
        // stand-in for the live ImprovementFork's classification step — same
        // intent (is this worth keeping?), no AgentLoop spawn at nightly time.
        validate: (candidate) => judgeSkillCandidate(candidate.content, llm),
      });
      console.log(
        `  skill candidate ${result.fileName ?? '(none)'}: ${result.decision} — ${result.reason}`,
      );
      return result.decision === 'promoted' ? 1 : 0;
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
