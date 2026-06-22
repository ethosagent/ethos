// `ethos personality evolve <id>` / `ethos personality revert <id>` /
// `ethos personality judge <id>` (Phases 3a/3b).
//
// Governed learning for a personality's Living Soul Expression. `evolve` gathers
// recent session evidence, drafts an Expression update via the LLM, shows the
// diff + rationale, and applies it only after explicit user approval (user mode)
// or auto-applies it behind a Personality-Judge alignment gate (auto mode).
// `revert` undoes the most recent Expression update. `judge` runs the
// Personality-Judge on-demand and reports an alignment score and any signal.
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { EvalRunner } from '@ethosagent/eval-harness';
import {
  GOOD_ALIGNMENT_THRESHOLD,
  type JudgeResult,
  scorePersonality,
} from '@ethosagent/personality-judge';
import { draftExpressionUpdate } from '@ethosagent/skill-evolver';
import { formatError, toEthosError } from '@ethosagent/types';
import type { EthosConfig } from '../config';
import { createAgentLoop, createLLM, getStorage } from '../wiring';

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

function oneLine(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length > 400 ? `${collapsed.slice(0, 400)}…` : collapsed;
}

function surface(err: unknown): never {
  process.stderr.write(`\n${formatError(toEthosError(err), { color: process.stderr.isTTY })}\n`);
  process.exit(1);
}

export interface RecentPrompts {
  prompts: Array<{ id: string; prompt: string }>;
  windowStart: string;
  windowEnd: string;
  elapsedHours: number;
  scopedNote: string;
}

const MAX_PROMPTS = 20;

// Gather recent raw USER-role prompts for the Judge, newest sessions first.
// Falls back to all-personality sessions (with a note) when none are scoped to
// this personality yet.
export async function gatherRecentUserPrompts(
  store: import('@ethosagent/session-sqlite').SQLiteSessionStore,
  id: string,
): Promise<RecentPrompts> {
  let scopedNote = '';
  let sessions = await store.listSessions({ personalityId: id });
  if (sessions.length === 0) {
    sessions = await store.listSessions();
    scopedNote =
      'evidence drawn from recent sessions across all personalities (none recorded for this personality yet)';
  }
  sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  const prompts: Array<{ id: string; prompt: string }> = [];
  const timestamps: number[] = [];
  for (const s of sessions) {
    if (prompts.length >= MAX_PROMPTS) break;
    const msgs = await store.getMessages(s.id, { limit: 20 });
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m?.role !== 'user') continue;
      if (prompts.length >= MAX_PROMPTS) break;
      prompts.push({ id: m.id || `${s.id}:${i}`, prompt: m.content });
      timestamps.push(m.timestamp.getTime());
    }
  }

  const oldest = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
  const newest = timestamps.length > 0 ? Math.max(...timestamps) : Date.now();
  const elapsedHours = newest - oldest < 2 ? 0 : (newest - oldest) / 3_600_000;

  return {
    prompts,
    windowStart: new Date(oldest).toISOString(),
    windowEnd: new Date(newest).toISOString(),
    elapsedHours,
    scopedNote,
  };
}

// Build a newest-first user+assistant evidence digest for the Expression draft
// and memory consolidation. Returns the joined digest text and whether any
// sessions were found (callers decide how to handle the empty case).
export async function buildEvidenceDigest(
  store: import('@ethosagent/session-sqlite').SQLiteSessionStore,
  id: string,
): Promise<{ digest: string; hasSessions: boolean }> {
  const digestLines: string[] = [];
  let totalChars = 0;
  const MAX_MSGS = 20;
  const MAX_CHARS = 4000;

  let sessions = await store.listSessions({ personalityId: id });
  if (sessions.length === 0) sessions = await store.listSessions();
  if (sessions.length === 0) return { digest: '', hasSessions: false };
  sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  let capped = false;
  for (const s of sessions) {
    if (capped) break;
    const msgs = await store.getMessages(s.id, { limit: 20 });
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m) continue;
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const line = `${m.role}: ${oneLine(m.content)}`;
      if (digestLines.length >= MAX_MSGS || totalChars + line.length > MAX_CHARS) {
        digestLines.push('… [evidence truncated]');
        capped = true;
        break;
      }
      digestLines.push(line);
      totalChars += line.length;
    }
  }

  return { digest: digestLines.join('\n'), hasSessions: true };
}

// Build an EvalRunner the Judge can drive: real AgentLoop, LLM judge scorer,
// run history written under the personality's .judge-history/runs/.
export async function buildJudgeRunner(config: EthosConfig, id: string): Promise<EvalRunner> {
  const { ethosDir } = await import('../config');
  const { join } = await import('node:path');
  const storage = getStorage();
  const runsDir = join(ethosDir(), 'personalities', id, '.judge-history', 'runs');
  await storage.mkdir(runsDir);
  const { loop } = await createAgentLoop(config);
  const llm = await createLLM(config);
  return new EvalRunner(loop, {
    concurrency: 4,
    outputPath: join(runsDir, `${Date.now()}.jsonl`),
    defaultScorer: 'llm',
    llmProvider: llm,
    storage,
  });
}

function judgeStatePath(ethosDir: string, id: string, join: (...p: string[]) => string): string {
  return join(ethosDir, 'personalities', id, '.judge-history', 'state.json');
}

// Read the persisted consecutive-low-batch streak; 0 when missing/invalid.
export async function readJudgeStreak(id: string): Promise<number> {
  const { ethosDir } = await import('../config');
  const { join } = await import('node:path');
  const raw = await getStorage().read(judgeStatePath(ethosDir(), id, join));
  if (!raw) return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'lowStreak' in parsed) {
      const v = (parsed as { lowStreak: unknown }).lowStreak;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    }
  } catch {
    return 0;
  }
  return 0;
}

// Persist the streak + last Judge result alongside the personality.
export async function writeJudgeStreak(
  id: string,
  lowStreak: number,
  result: JudgeResult,
): Promise<void> {
  const { ethosDir } = await import('../config');
  const { join } = await import('node:path');
  const dir = join(ethosDir(), 'personalities', id, '.judge-history');
  await getStorage().mkdir(dir);
  await getStorage().writeAtomic(
    judgeStatePath(ethosDir(), id, join),
    JSON.stringify({ lowStreak, lastResult: result, at: new Date().toISOString() }, null, 2),
  );
}

// Actionable, voice-matched notification when the Judge fires a signal.
export function signalNotice(id: string, signal: NonNullable<JudgeResult['signal']>): string {
  if (signal === 'underspecified_soul') {
    return `⚠ ${id} has scored low for a sustained run — its Core/Expression may be under-specified. Flesh out the soul.`;
  }
  return `⚠ ${id} has scored low for a sustained run — its responses are drifting from Core. Review the soul.`;
}

export async function runPersonalityJudge(argv: string[]): Promise<void> {
  const id = argv.find((a) => !a.startsWith('-'));
  if (!id) {
    console.log('Usage: ethos personality judge <id>');
    return;
  }

  try {
    const { createPersonalityRegistry } = await import('@ethosagent/personalities');
    const { ethosDir, readConfig } = await import('../config');
    const { join } = await import('node:path');
    const { getSecretsResolver } = await import('../wiring');

    const storage = getStorage();
    const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
    await reg.loadFromDirectory(join(ethosDir(), 'personalities'));

    const described = reg.describe(id);
    if (!described) {
      console.error(`Unknown personality: ${id}`);
      console.error('Run `ethos personality list` to see available ids.');
      process.exit(1);
    }

    const config = await readConfig(getStorage(), await getSecretsResolver());
    if (!config) {
      console.error('Run `ethos setup` first.');
      process.exit(1);
    }

    const soul = await reg.readLivingSoul(id);

    const { SQLiteSessionStore } = await import('@ethosagent/session-sqlite');
    const store = new SQLiteSessionStore(join(ethosDir(), 'sessions.db'));
    let recent: RecentPrompts;
    try {
      recent = await gatherRecentUserPrompts(store, id);
    } finally {
      store.close();
    }

    const priorLowStreak = await readJudgeStreak(id);
    const runner = await buildJudgeRunner(config, id);
    const judge = described.config.nightly?.judge;
    const outcome = await scorePersonality({
      personalityId: id,
      core: soul.core,
      expression: soul.expression,
      recentPrompts: recent.prompts,
      windowStart: recent.windowStart,
      windowEnd: recent.windowEnd,
      elapsedHours: recent.elapsedHours,
      priorLowStreak,
      runner,
      activation: { minInteractions: judge?.minInteractions ?? 20, minElapsedHours: 12 },
    });

    if (recent.scopedNote) console.log(recent.scopedNote);

    if (outcome.kind === 'insufficient_data') {
      console.log(`Not enough data to judge: ${outcome.reason}`);
      return;
    }

    const { result } = outcome;
    console.log(`=== Personality Judge: ${id} ===`);
    console.log(`alignment: ${(result.alignmentScore * 100).toFixed(0)}%`);
    console.log(`samples:   ${result.sampleCount}`);
    for (const d of result.perDimension) {
      console.log(`  ${d.id}: ${(d.score * 100).toFixed(0)}% — ${d.evidence}`);
    }
    if (result.signal) console.log(`\n${signalNotice(id, result.signal)}`);

    await writeJudgeStreak(id, outcome.lowStreak, result);
  } catch (err) {
    surface(err);
  }
}

export async function runPersonalityEvolve(argv: string[]): Promise<void> {
  const id = argv.find((a) => !a.startsWith('-'));
  if (!id) {
    console.log('Usage: ethos personality evolve <id>');
    return;
  }

  try {
    const { createPersonalityRegistry } = await import('@ethosagent/personalities');
    const { ethosDir, readConfig } = await import('../config');
    const { join } = await import('node:path');
    const { getSecretsResolver } = await import('../wiring');

    const storage = getStorage();
    const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
    await reg.loadFromDirectory(join(ethosDir(), 'personalities'));

    const described = reg.describe(id);
    if (!described) {
      console.error(`Unknown personality: ${id}`);
      console.error('Run `ethos personality list` to see available ids.');
      process.exit(1);
    }

    const config = await readConfig(getStorage(), await getSecretsResolver());
    if (!config) {
      console.error('Run `ethos setup` first.');
      process.exit(1);
    }

    const autoMode = described.config.evolution_approval_mode === 'auto';

    // Gather both the raw USER prompts (for the Judge) and the newest-first
    // user+assistant evidence digest (for drafting) in a single store open.
    const { SQLiteSessionStore } = await import('@ethosagent/session-sqlite');
    const store = new SQLiteSessionStore(join(ethosDir(), 'sessions.db'));

    let scopedNote = '';
    let recent: RecentPrompts;
    let evidence: string;
    try {
      recent = await gatherRecentUserPrompts(store, id);
      scopedNote = recent.scopedNote;

      const built = await buildEvidenceDigest(store, id);
      if (!built.hasSessions) {
        console.log(
          'No recent session evidence yet — interact with this personality first, then evolve.',
        );
        return;
      }
      evidence = built.digest;
    } finally {
      store.close();
    }

    const soul = await reg.readLivingSoul(id);
    const llm = await createLLM(config);

    if (autoMode) {
      if (scopedNote) console.log(scopedNote);

      const priorLowStreak = await readJudgeStreak(id);
      const runner = await buildJudgeRunner(config, id);
      const judge = described.config.nightly?.judge;
      const outcome = await scorePersonality({
        personalityId: id,
        core: soul.core,
        expression: soul.expression,
        recentPrompts: recent.prompts,
        windowStart: recent.windowStart,
        windowEnd: recent.windowEnd,
        elapsedHours: recent.elapsedHours,
        priorLowStreak,
        runner,
        activation: { minInteractions: judge?.minInteractions ?? 20, minElapsedHours: 12 },
      });

      if (outcome.kind === 'insufficient_data') {
        console.log(`Not enough data to judge: ${outcome.reason}`);
        return;
      }

      const { result } = outcome;
      await writeJudgeStreak(id, outcome.lowStreak, result);

      if (result.signal) console.log(signalNotice(id, result.signal));

      const pct = (result.alignmentScore * 100).toFixed(0);
      if (result.alignmentScore >= GOOD_ALIGNMENT_THRESHOLD) {
        console.log(`already well-aligned (${pct}%); no Expression change applied.`);
        return;
      }

      const draft = await draftExpressionUpdate(
        { core: soul.core, currentExpression: soul.expression, evidence },
        llm,
      );
      const { entry } = await reg.evolveExpression(id, draft.newExpression, {
        summary: draft.rationale.slice(0, 120) || 'auto expression update',
        evidenceRef: `judge:${result.alignmentScore.toFixed(2)}@${result.windowEnd}`,
      });
      console.log(
        `✓ auto-applied Expression update behind Judge gate (alignment ${pct}%, revision ${entry.revisionId}). Undo with \`ethos personality revert ${id}\`.`,
      );
      return;
    }

    // User-approval flow (Phase 3a): draft → show evidence + diff → confirm → apply.
    const draft = await draftExpressionUpdate(
      { core: soul.core, currentExpression: soul.expression, evidence },
      llm,
    );

    if (scopedNote) {
      console.log(scopedNote);
    }
    console.log('=== Evidence (recent interactions) ===');
    console.log(evidence);
    console.log('=== Rationale ===');
    console.log(draft.rationale || '(no rationale provided)');
    console.log('=== Proposed Expression change ===');
    if (soul.expression.trim() === '') {
      console.log(
        'This soul has no Expression region yet; this will create one (Core stays untouched).',
      );
      console.log(draft.newExpression);
    } else {
      const { unifiedDiff } = await import('../index');
      console.log(
        unifiedDiff(
          soul.expression,
          draft.newExpression,
          'expression (current)',
          'expression (proposed)',
        ),
      );
    }

    const ok = await confirm('Apply this Expression update? [y/N] ');
    if (!ok) {
      console.log('Aborted — no changes.');
      return;
    }

    const { entry } = await reg.evolveExpression(id, draft.newExpression, {
      summary: draft.rationale.slice(0, 120) || 'expression update',
      evidenceRef: `sessions:${new Date().toISOString()}`,
    });
    console.log(`✓ Expression updated (revision ${entry.revisionId}).`);
    console.log('Undo with `ethos personality revert <id>`.');
  } catch (err) {
    surface(err);
  }
}

export async function runPersonalityRevert(argv: string[]): Promise<void> {
  const id = argv.find((a) => !a.startsWith('-'));
  if (!id) {
    console.log('Usage: ethos personality revert <id>');
    return;
  }

  try {
    const { createPersonalityRegistry } = await import('@ethosagent/personalities');
    const { ethosDir } = await import('../config');
    const { join } = await import('node:path');

    const storage = getStorage();
    const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
    await reg.loadFromDirectory(join(ethosDir(), 'personalities'));

    const described = reg.describe(id);
    if (!described) {
      console.error(`Unknown personality: ${id}`);
      console.error('Run `ethos personality list` to see available ids.');
      process.exit(1);
    }

    const soul = await reg.readLivingSoul(id);
    if (soul.learningLog.length === 0) {
      console.log('Nothing to revert.');
      return;
    }
    const last = soul.learningLog[soul.learningLog.length - 1];
    if (!last) {
      console.log('Nothing to revert.');
      return;
    }

    console.log(
      `This will restore the Expression snapshot from before: "${last.summary}" (revision ${last.revisionId}).`,
    );
    console.log(`Restoring snapshot: ${last.prevExpressionRef}`);

    const ok = await confirm('Revert to that snapshot? [y/N] ');
    if (!ok) {
      console.log('Aborted.');
      return;
    }

    await reg.revertExpression(id, last.prevExpressionRef);
    console.log(`✓ Reverted "${id}" to snapshot ${last.prevExpressionRef}.`);
  } catch (err) {
    surface(err);
  }
}
