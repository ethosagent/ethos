// `ethos personality evolve <id>` / `ethos personality revert <id>` /
// `ethos personality judge <id>` (Phases 3a/3b).
//
// Governed learning for a personality's Living Soul Expression. `evolve` gathers
// recent session evidence, drafts an Expression update via the LLM, and submits
// it to the learning inbox (path 4, plan `trust-before-reach.md` Part 4).
//   user mode: shows the diff + rationale; `y` is a human approval and promotes
//     the candidate through `LearningInbox.approve`, `N` rejects it through
//     `LearningInbox.reject`. A candidate that has not passed a replay needs an
//     override reason (the inbox's rule), so `y` asks for one; an empty reason
//     cancels the approval and the candidate stays waiting.
//   auto mode: the Judge decides only WHETHER to draft (L-D2). The draft waits
//     in the inbox and goes live only on a `pass` replay (`replayAndResolve`).
// Both modes first offer any Expression candidate already waiting for this
// personality — what the nightly pass drafted — in user mode.
// `revert` undoes the most recent Expression update. `judge` runs the
// Personality-Judge on-demand and reports an alignment score and any signal.
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { EthosConfig } from '@ethosagent/config';
import { EvalRunner } from '@ethosagent/eval-harness';
import {
  CASE_CONTEXT_MESSAGES,
  caseFromSessionTurn,
  freezeCase,
  LEARNING_EXCLUDED_KEY_PREFIXES,
  type LearningCandidate,
  type LearningInbox,
  MAX_TARGET_CASES,
  type SessionCaseTurn,
} from '@ethosagent/learning-inbox';
import {
  GOOD_ALIGNMENT_THRESHOLD,
  type JudgeResult,
  scorePersonality,
} from '@ethosagent/personality-judge';
import { draftExpressionUpdate } from '@ethosagent/skill-evolver';
import { formatError, toEthosError } from '@ethosagent/types';
import {
  importLegacyLearningQueues,
  listPendingExpressionCandidates,
  personalityCore,
  submitExpressionCandidate,
} from '@ethosagent/wiring';
import { releaseCommandRuntime } from '../lib/release-command-runtime';
import { createAgentLoop, createCliLearningInbox, createLLM, getStorage } from '../wiring';

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function confirm(question: string): Promise<boolean> {
  const answer = (await ask(question)).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

const OVERRIDE_REASON_PROMPT =
  'This change has not passed a replay. Why approve it anyway? (empty cancels) ';

function oneLine(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length > 400 ? `${collapsed.slice(0, 400)}…` : collapsed;
}

function surface(err: unknown): never {
  process.stderr.write(`\n${formatError(toEthosError(err), { color: process.stderr.isTTY })}\n`);
  process.exit(1);
}

// Rationale + diff, the way `evolve` has always shown them. Shared so a draft
// the nightly pass queued is reviewed with exactly the same surface as one
// drafted in-session (plan `trust-before-reach.md` B-T1).
async function printExpressionProposal(
  currentExpression: string,
  newExpression: string,
  rationale: string,
): Promise<void> {
  console.log('=== Rationale ===');
  console.log(rationale || '(no rationale provided)');
  console.log('=== Proposed Expression change ===');
  if (currentExpression.trim() === '') {
    console.log(
      'This soul has no Expression region yet; this will create one (Core stays untouched).',
    );
    console.log(newExpression);
    return;
  }
  const { unifiedDiff } = await import('../index');
  console.log(
    unifiedDiff(currentExpression, newExpression, 'expression (current)', 'expression (proposed)'),
  );
}

const DECIDED_BY = 'ethos personality evolve';

/**
 * Put a CLI human's answer on an Expression candidate, through the learning
 * inbox — the one owner of the override rule and of the `learning.*` audit row
 * each decision writes (`LearningInbox`, `extensions/learning-inbox/src/inbox.ts`).
 *
 *   `N`  → `inbox.reject`: one `learning.reject` row.
 *   `y`  → `inbox.approve`. A verdict other than `pass` (a `user`-mode candidate
 *          is never replayed) needs a reason, so `askReason` is called first;
 *          the inbox refuses a blank one with `override_required`, which writes
 *          nothing, and that refusal is reported as `cancelled` — the candidate
 *          stays waiting. A landed approval writes one `learning.override` (or
 *          `learning.approve`) row.
 *
 * No reason is ever supplied on the human's behalf. Exported for the test;
 * `runPersonalityEvolve` is its one caller.
 */
export async function decideExpressionCandidate(args: {
  inbox: Pick<LearningInbox, 'approve' | 'reject'>;
  candidate: LearningCandidate;
  approved: boolean;
  /** Asked only after `y`, and only when the candidate has not passed a replay. */
  askReason: () => Promise<string>;
}): Promise<
  | { outcome: 'applied'; revisionId: string }
  | { outcome: 'declined' }
  | { outcome: 'cancelled'; reason: string }
  | { outcome: 'refused'; reason: string }
> {
  const who = { actor: 'cli', decidedBy: DECIDED_BY };
  if (!args.approved) {
    const rejected = await args.inbox.reject(args.candidate.id, {
      ...who,
      reason: 'declined at `ethos personality evolve`',
    });
    if (!rejected.ok) return { outcome: 'refused', reason: rejected.reason };
    return { outcome: 'declined' };
  }
  const reason = args.candidate.verdict === 'pass' ? '' : await args.askReason();
  const result = await args.inbox.approve(args.candidate.id, {
    ...who,
    override: reason ? { reason } : undefined,
  });
  if (!result.ok) {
    return result.code === 'override_required'
      ? { outcome: 'cancelled', reason: result.reason }
      : { outcome: 'refused', reason: result.reason };
  }
  return {
    outcome: 'applied',
    revisionId: result.value.record.kind === 'expression' ? result.value.record.revisionId : '',
  };
}

function printCancelled(candidateId: string): void {
  console.log('Not applied — no reason given, so nothing was approved.');
  console.log(
    `The candidate is still waiting: \`ethos learning approve ${candidateId} --override "<reason>"\`.`,
  );
}

export interface RecentPrompts {
  prompts: Array<{ id: string; prompt: string }>;
  /**
   * The session turn behind each prompt, in the same order, with `messageId`
   * equal to the prompt's `id` — which is the `task_id` the Judge's run file
   * records. `judgeZeroScoredTurns` resolves a scored prompt back through this.
   */
  turns: SessionCaseTurn[];
  windowStart: string;
  windowEnd: string;
  elapsedHours: number;
  scopedNote: string;
}

const MAX_PROMPTS = 20;

/**
 * Sessions Ethos itself drove are not evidence about how Ethos is doing
 * (plan `trust-before-reach.md` L-D12). Without this the Judge's own replays
 * — `eval:<pid>:<promptId>` rows `EvalRunner` writes to `sessions.db` — were
 * read back as user prompts the next night, so the drafts and the case pool
 * were built from the system's output; Parts 2 and 3 added `mcp:`,
 * `outbox-review:` and `replay:` turns to the same pile.
 *
 * `LEARNING_EXCLUDED_KEY_PREFIXES` is the ONE list (X-D7) and lives in
 * `extensions/learning-inbox/src/cases.ts`, beside the case capture that is
 * its other reader. Imported, not copied: `apps/ethos` sits above
 * `extensions/` in the layer model, so the edge runs the right way.
 */
const LEARNING_EVIDENCE_FILTER = {
  excludeKeyPrefixes: [...LEARNING_EXCLUDED_KEY_PREFIXES],
};

type EvidenceMessage = import('@ethosagent/types').StoredMessage;

// Up to `CASE_CONTEXT_MESSAGES` plain-text messages before `index`, oldest
// first — the same context a frozen session case carries everywhere else.
function precedingPlainText(
  msgs: readonly (EvidenceMessage | undefined)[],
  index: number,
): string[] {
  const context: string[] = [];
  for (let j = index - 1; j >= 0 && context.length < CASE_CONTEXT_MESSAGES; j--) {
    const m = msgs[j];
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || !m.content.trim()) continue;
    context.push(m.content);
  }
  return context.reverse();
}

// Gather recent raw USER-role prompts for the Judge, newest sessions first.
// Falls back to all-personality sessions (with a note) when none are scoped to
// this personality yet.
export async function gatherRecentUserPrompts(
  store: import('@ethosagent/session-sqlite').SQLiteSessionStore,
  id: string,
): Promise<RecentPrompts> {
  let scopedNote = '';
  let sessions = await store.listSessions({ personalityId: id, ...LEARNING_EVIDENCE_FILTER });
  if (sessions.length === 0) {
    sessions = await store.listSessions({ ...LEARNING_EVIDENCE_FILTER });
    scopedNote =
      'evidence drawn from recent sessions across all personalities (none recorded for this personality yet)';
  }
  sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  const prompts: Array<{ id: string; prompt: string }> = [];
  const turns: SessionCaseTurn[] = [];
  const timestamps: number[] = [];
  for (const s of sessions) {
    if (prompts.length >= MAX_PROMPTS) break;
    const msgs = await store.getMessages(s.id, { limit: 20 });
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m?.role !== 'user') continue;
      if (prompts.length >= MAX_PROMPTS) break;
      const promptId = m.id || `${s.id}:${i}`;
      prompts.push({ id: promptId, prompt: m.content });
      turns.push({
        sessionKey: s.key,
        messageId: promptId,
        prompt: m.content,
        context: precedingPlainText(msgs, i),
      });
      timestamps.push(m.timestamp.getTime());
    }
  }

  const oldest = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
  const newest = timestamps.length > 0 ? Math.max(...timestamps) : Date.now();
  const elapsedHours = newest - oldest < 2 ? 0 : (newest - oldest) / 3_600_000;

  return {
    prompts,
    turns,
    windowStart: new Date(oldest).toISOString(),
    windowEnd: new Date(newest).toISOString(),
    elapsedHours,
    scopedNote,
  };
}

export interface EvidenceDigest {
  /** The joined digest text the drafters read. */
  digest: string;
  /** Whether any sessions were found (callers decide how to handle the empty case). */
  hasSessions: boolean;
  /** Every message the digest quotes, in digest order (newest first). */
  messageIds: string[];
  /** The sessions those messages belong to, in the order the digest first quotes them. */
  sessionIds: string[];
  /**
   * The USER messages among `messageIds`, same order, as freezable turns. A
   * nightly skill candidate's target cases are frozen from exactly these
   * (Design §2) — never from a recent turn the digest did not quote.
   */
  userTurns: SessionCaseTurn[];
}

// Build a newest-first user+assistant evidence digest for the Expression draft
// and memory consolidation, and report which messages it quoted.
export async function buildEvidenceDigest(
  store: import('@ethosagent/session-sqlite').SQLiteSessionStore,
  id: string,
): Promise<EvidenceDigest> {
  const digestLines: string[] = [];
  let totalChars = 0;
  const MAX_MSGS = 20;
  const MAX_CHARS = 4000;

  let sessions = await store.listSessions({ personalityId: id, ...LEARNING_EVIDENCE_FILTER });
  if (sessions.length === 0) sessions = await store.listSessions({ ...LEARNING_EVIDENCE_FILTER });
  if (sessions.length === 0) {
    return { digest: '', hasSessions: false, messageIds: [], sessionIds: [], userTurns: [] };
  }
  sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  const messageIds: string[] = [];
  const sessionIds: string[] = [];
  const userTurns: SessionCaseTurn[] = [];
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
      const messageId = m.id || `${s.id}:${i}`;
      messageIds.push(messageId);
      if (!sessionIds.includes(s.id)) sessionIds.push(s.id);
      if (m.role === 'user') {
        userTurns.push({
          sessionKey: s.key,
          messageId,
          prompt: m.content,
          context: precedingPlainText(msgs, i),
        });
      }
    }
  }

  return { digest: digestLines.join('\n'), hasSessions: true, messageIds, sessionIds, userTurns };
}

/**
 * The prompts the Judge scored 0 in one run file, resolved to the turns they
 * were drawn from — a nightly Expression candidate's target cases (Design §2).
 *
 * The run file is `EvalRunner`'s output (`extensions/eval-harness/src/runner.ts`):
 * one JSON `AtroposRecord` per line, a `user` record (the prompt) then an
 * `assistant` record carrying `score` for each task, both keyed by `task_id`,
 * which is the prompt's `id` from `gatherRecentUserPrompts`.
 *
 * A task that errored also carries `score: 0`, but the runner never graded it
 * (`score` stays 0 when `errorMsg` is set) — that is a failed run, not a bad
 * answer, so it is not a target. An unparseable line is skipped. A zero-scored
 * `task_id` with no matching turn is dropped rather than frozen from the run
 * file's text alone, because without the turn there is no session key to hold
 * against `LEARNING_EXCLUDED_KEY_PREFIXES`.
 *
 * No zero-scored prompt means an empty list, and the caller must not fill it:
 * a candidate with no target replays `incomplete` (`computeVerdict` rule (a)).
 */
export function judgeZeroScoredTurns(
  runFile: string | null,
  judgedTurns: readonly SessionCaseTurn[],
): SessionCaseTurn[] {
  if (!runFile) return [];
  const zeroScored = new Set<string>();
  for (const line of runFile.split('\n')) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    const { role, task_id, score, error } = record as Record<string, unknown>;
    if (role === 'assistant' && typeof task_id === 'string' && score === 0 && error === undefined) {
      zeroScored.add(task_id);
    }
  }
  return judgedTurns.filter((t) => zeroScored.has(t.messageId));
}

/**
 * Freeze target cases from exactly `turns`, in order, at most
 * `MAX_TARGET_CASES` (L-D6), and return their ids. A turn whose session key is
 * under `LEARNING_EXCLUDED_KEY_PREFIXES` is refused by `caseFromSessionTurn`
 * and never becomes a target. Nothing is added to make up a short list.
 */
export async function freezeTargetTurnCases(
  ctx: Parameters<typeof personalityCore>[0],
  personalityId: string,
  turns: readonly SessionCaseTurn[],
): Promise<string[]> {
  if (turns.length === 0) return [];
  const core = await personalityCore(ctx, personalityId);
  const frozenAt = new Date().toISOString();
  const ids: string[] = [];
  for (const turn of turns) {
    if (ids.length >= MAX_TARGET_CASES) break;
    const learningCase = caseFromSessionTurn(personalityId, turn, core, frozenAt);
    if (!learningCase || ids.includes(learningCase.id)) continue;
    await freezeCase(ctx.storage, ctx.dataDir, learningCase);
    ids.push(learningCase.id);
  }
  return ids;
}

// Build an EvalRunner the Judge can drive: real AgentLoop, LLM judge scorer,
// run history written under the personality's .judge-history/runs/.
export async function buildJudgeRunner(
  config: EthosConfig,
  id: string,
): Promise<{ runner: EvalRunner; release: () => Promise<void>; outputPath: string }> {
  const { ethosDir } = await import('@ethosagent/config');
  const { join } = await import('node:path');
  const storage = getStorage();
  const runsDir = join(ethosDir(), 'personalities', id, '.judge-history', 'runs');
  await storage.mkdir(runsDir);
  const runtime = await createAgentLoop(config);
  const llm = await createLLM(config);
  const outputPath = join(runsDir, `${Date.now()}.jsonl`);
  const runner = new EvalRunner(runtime.loop, {
    concurrency: 4,
    outputPath,
    defaultScorer: 'llm',
    llmProvider: llm,
    storage,
  });
  // The judge builds a whole agent loop to score with. `release` is the caller's
  // obligation, not a nicety: without it every `ethos personality judge` and
  // every nightly scoring pass exits on live SQLite handles (G4).
  return {
    runner,
    release: () => releaseCommandRuntime(runtime, { label: 'judge agent loop' }),
    // The run file this runner writes — what `judgeZeroScoredTurns` reads.
    outputPath,
  };
}

function judgeStatePath(ethosDir: string, id: string, join: (...p: string[]) => string): string {
  return join(ethosDir, 'personalities', id, '.judge-history', 'state.json');
}

// Read the persisted consecutive-low-batch streak; 0 when missing/invalid.
export async function readJudgeStreak(id: string): Promise<number> {
  const { ethosDir } = await import('@ethosagent/config');
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
  const { ethosDir } = await import('@ethosagent/config');
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
    const { ethosDir, readConfig } = await import('@ethosagent/config');
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
    const { runner, release } = await buildJudgeRunner(config, id);
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
    }).finally(release);

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
    const { ethosDir, readConfig } = await import('@ethosagent/config');
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
    const soul = await reg.readLivingSoul(id);
    const dataDir = ethosDir();
    const learningCtx = { storage, dataDir, personalities: reg };

    // Drafts parked by an older release (B-T1's `learning/pending-expression/`
    // and the skill queues) become inbox candidates first, once.
    await importLegacyLearningQueues({
      ...learningCtx,
      defaultPersonalityId: reg.getDefault().id,
    });

    // An Expression candidate already waiting — typically tonight's nightly
    // draft — is offered first, before any evidence gathering: it must stay
    // reachable on a personality with no NEW sessions to draft from. Only in
    // user mode; an `auto` personality's candidates wait for replay.
    if (!autoMode) {
      const [waiting] = await listPendingExpressionCandidates(learningCtx, id);
      if (waiting) {
        console.log(
          `=== Waiting Expression candidate ${waiting.id} (${waiting.origin}, ${
            waiting.verdict ? `replay: ${waiting.verdict}` : 'not replayed'
          }) ===`,
        );
        console.log(`drafted ${waiting.submittedAt}`);
        await printExpressionProposal(
          soul.expression,
          waiting.content,
          waiting.evidence.digest ?? '',
        );
        const decided = await decideExpressionCandidate({
          inbox: await createCliLearningInbox(config),
          candidate: waiting,
          approved: await confirm('Apply this Expression update? [y/N] '),
          askReason: () => ask(OVERRIDE_REASON_PROMPT),
        });
        if (decided.outcome === 'applied') {
          console.log(`✓ Expression updated (revision ${decided.revisionId}).`);
          console.log('Undo with `ethos personality revert <id>`.');
        } else if (decided.outcome === 'cancelled') {
          printCancelled(waiting.id);
        } else if (decided.outcome === 'refused') {
          console.log(`Not applied: ${decided.reason}. Re-run to draft a fresh one.`);
        } else {
          // Declined: the user just said no to this personality's Expression
          // changing. Drafting a fresh one and asking again would be arguing.
          console.log('Aborted — no changes. The candidate was rejected.');
        }
        return;
      }
    }

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

    const llm = await createLLM(config);

    if (autoMode) {
      if (scopedNote) console.log(scopedNote);

      const priorLowStreak = await readJudgeStreak(id);
      const { runner, release, outputPath } = await buildJudgeRunner(config, id);
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
      }).finally(release);

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
      // L-D2: the Judge said draft; it does not say apply. An unevaluated draft
      // waits for a `pass` replay. Its target cases are the prompts the Judge
      // scored 0 in the run it just performed (Design §2) — and none when it
      // scored none: no recent turn is frozen to fill the gap, so a candidate
      // without a target replays `incomplete` and waits for a human.
      const targetCaseIds = await freezeTargetTurnCases(
        learningCtx,
        id,
        judgeZeroScoredTurns(await storage.read(outputPath), recent.turns),
      );
      const candidate = await submitExpressionCandidate(learningCtx, {
        personalityId: id,
        origin: 'cli',
        newExpression: draft.newExpression,
        rationale: draft.rationale,
        evidenceRef: `judge:${result.alignmentScore.toFixed(2)}@${result.windowEnd}`,
        targetCaseIds,
      });
      console.log(
        `✓ Expression draft submitted as learning candidate ${candidate.id} (alignment ${pct}%). It goes live only after a passing replay: run \`ethos learning replay ${candidate.id}\`, or let the nightly pass replay it.`,
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
    await printExpressionProposal(soul.expression, draft.newExpression, draft.rationale);

    // Submitted before the answer, so a declined draft is still on the record
    // (as `rejected`) rather than gone.
    const candidate = await submitExpressionCandidate(learningCtx, {
      personalityId: id,
      origin: 'cli',
      newExpression: draft.newExpression,
      rationale: draft.rationale,
      evidenceRef: `sessions:${new Date().toISOString()}`,
      // No target cases: user mode runs no Judge, so there is no failure
      // evidence to target — the digest is recent turns, not a record of what
      // went wrong, and Design §2 names no target source for this path. The
      // human's y/N decides this candidate, not a replay verdict.
      targetCaseIds: [],
    });
    const decided = await decideExpressionCandidate({
      inbox: await createCliLearningInbox(config),
      candidate,
      approved: await confirm('Apply this Expression update? [y/N] '),
      askReason: () => ask(OVERRIDE_REASON_PROMPT),
    });
    if (decided.outcome === 'declined') {
      console.log('Aborted — no changes.');
      return;
    }
    if (decided.outcome === 'cancelled') {
      printCancelled(candidate.id);
      return;
    }
    if (decided.outcome === 'refused') {
      console.log(`Not applied: ${decided.reason}.`);
      return;
    }
    console.log(`✓ Expression updated (revision ${decided.revisionId}).`);
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
    const { ethosDir } = await import('@ethosagent/config');
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
