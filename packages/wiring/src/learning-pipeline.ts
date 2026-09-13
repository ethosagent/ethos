// The learning inbox's composition root (plan `trust-before-reach.md` Part 4,
// L-T6). `@ethosagent/learning-inbox` owns the store, the replay runner, the
// resolver and promotion, and depends on nothing above `@ethosagent/types`;
// every package it needs — `skill-evolver` (`liveSkillDir`, the evolve config),
// `skills` (`checkSkillFrontmatter`), `personalities` (the Living Soul parser),
// `kanban-store`, and a real replay loop — is bound to it here, in wiring,
// which is the one layer allowed to import them all (ARCHITECTURE.md §II).
//
// Every surface that submits, replays or promotes goes through these helpers:
//   - `learningSubmitPort`      the fork and chat `skill_propose`, the nightly
//                               skill drafter, the eval-driven evolver
//   - `learningPromoteDeps`     every human approval and the auto path
//   - `learningPolicyFor`       the ONE reader of the three auto knobs (L-D3)
//   - `createLearningReplayer`  the nightly `replay` step and `--auto-approve`
//   - `importLegacyLearningQueues`  the one-time drain of the four old queues
//   - `createLearningInbox`     the review inbox every HUMAN decision goes
//                               through (L-T8): web `learning.*`, `ethos
//                               learning`, the legacy verbs, the chat tools
//   - `freezeLatestUserTurnCase` / `freezeRecentSessionCases` / `freezeNightlyCases`
//                               target and regression cases (L-T2's builders)

import { basename, join } from 'node:path';
import { InMemorySessionStore } from '@ethosagent/core';
import { KanbanStore } from '@ethosagent/kanban-store';
import {
  type AutoPromotionKnobs,
  AWAITING_DECISION,
  CASE_CONTEXT_MESSAGES,
  type CaptureCasesResult,
  captureCases,
  caseFromSessionTurn,
  type ExpressionRevisions,
  freezeCase,
  importLegacyQueues,
  type KanbanCaseTask,
  LEARNING_EXCLUDED_KEY_PREFIXES,
  type LearningCandidate,
  LearningInbox,
  type LearningObservability,
  type LegacyImportResult,
  listCandidates,
  type PromoteDeps,
  type PromoteOptions,
  type PromoteResult,
  promote,
  type ReplayAndResolveResult,
  readCandidate,
  replayAndResolve,
  type SessionCaseTurn,
  type SkillScope,
  submitCandidate,
  updateCandidate,
} from '@ethosagent/learning-inbox';
import { parseLivingSoul } from '@ethosagent/personalities';
import { type LearningSubmitPort, liveSkillDir, loadEvolveConfig } from '@ethosagent/skill-evolver';
import { checkSkillFrontmatter, parseSkillFrontmatter } from '@ethosagent/skills';
import type { PendingSkillSummary, PendingSkillsPort } from '@ethosagent/tools-skills';
import type {
  LLMProvider,
  PersonalityRegistry,
  Session,
  SessionFilter,
  Storage,
  StoredMessage,
} from '@ethosagent/types';
import type { WiringConfig } from './index';
import { createReplayLoop, REPLAY_RUN_OPTIONS, shadowForCandidate } from './learning-replay';

/** What every helper here reads. */
export interface LearningContext {
  storage: Storage;
  /** `~/.ethos` (or `ETHOS_STATE_DIR`). */
  dataDir: string;
}

type PersonalityLookup = Pick<PersonalityRegistry, 'get'>;

/** The session-store slice case capture reads. `SQLiteSessionStore` fits. */
export interface CaseSessionSource {
  listSessions(filter?: SessionFilter & { excludeKeyPrefixes?: string[] }): Promise<Session[]>;
  getMessages(sessionId: string, options?: { limit?: number }): Promise<StoredMessage[]>;
}

// --- Submit and promote ------------------------------------------------------

/** The inbox, bound to a Storage and a data dir, as `@ethosagent/skill-evolver` consumes it. */
export function learningSubmitPort(ctx: LearningContext): LearningSubmitPort {
  return {
    submit: (input) => submitCandidate(ctx.storage, ctx.dataDir, input),
    has: async (id) => (await readCandidate(ctx.storage, ctx.dataDir, id)) !== null,
  };
}

/** The live `SOUL.md` an Expression candidate for this personality lands on. */
function soulFileOf(
  ctx: LearningContext & { personalities: PersonalityLookup },
  personalityId: string,
): string {
  return (
    ctx.personalities.get(personalityId)?.soulFile ??
    join(ctx.dataDir, 'personalities', personalityId, 'SOUL.md')
  );
}

/**
 * Submit an Expression draft (paths 3, 4 and 5: nightly, `ethos personality
 * evolve`, the web Living Soul editor). One owner for the destination, so the
 * three drafters cannot disagree about which file a draft is measured against.
 */
export async function submitExpressionCandidate(
  ctx: LearningContext & { personalities: PersonalityLookup },
  input: {
    personalityId: string;
    origin: 'nightly' | 'cli' | 'web';
    newExpression: string;
    rationale: string;
    evidenceRef: string;
    evidenceSessionIds?: string[];
    targetCaseIds?: readonly string[];
  },
): Promise<LearningCandidate> {
  return submitCandidate(ctx.storage, ctx.dataDir, {
    kind: 'expression',
    op: 'update',
    personalityId: input.personalityId,
    origin: input.origin,
    destination: soulFileOf(ctx, input.personalityId),
    content: input.newExpression,
    evidence: {
      sessionIds: input.evidenceSessionIds ?? [],
      digest: input.rationale,
      ref: input.evidenceRef,
    },
    targetCaseIds: input.targetCaseIds ?? [],
  });
}

/** Expression candidates still waiting for a decision, newest first. */
export async function listPendingExpressionCandidates(
  ctx: LearningContext,
  personalityId: string,
): Promise<LearningCandidate[]> {
  return listCandidates(ctx.storage, ctx.dataDir, {
    personalityId,
    kind: 'expression',
    status: ['pending_replay', 'pending_review'],
  });
}

/**
 * A HUMAN approval (`ethos personality evolve`'s `y`, the web apply). Refusals
 * (`stale`, `invalid`) are returned, not thrown — `promote()`'s contract.
 */
export function promoteLearningCandidate(
  ctx: LearningContext & { personalities: PersonalityLookup; expressions: ExpressionRevisions },
  candidateId: string,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  return promote(learningPromoteDeps(ctx), candidateId, opts);
}

/** A human rejection. Rejecting only narrows, so it needs no replay. */
export function rejectLearningCandidate(
  ctx: LearningContext,
  candidateId: string,
  opts: { actor: string; reason?: string },
): Promise<LearningCandidate> {
  return updateCandidate(ctx.storage, ctx.dataDir, candidateId, {
    status: 'rejected',
    actor: opts.actor,
    ...(opts.reason ? { reason: opts.reason } : {}),
  });
}

/** `PromoteDeps` with the real scope mapping, frontmatter gate and Expression registry. */
export function learningPromoteDeps(
  ctx: LearningContext & { personalities: PersonalityLookup; expressions: ExpressionRevisions },
): PromoteDeps {
  return {
    storage: ctx.storage,
    dataDir: ctx.dataDir,
    liveSkillDir,
    skillScope: (pid) => ctx.personalities.get(pid)?.skill_evolution?.scope,
    checkSkillFrontmatter: (md) => {
      const check = checkSkillFrontmatter(md);
      return check.ok ? { ok: true } : { ok: false, error: check.error };
    },
    expressions: ctx.expressions,
  };
}

/**
 * L-D3's knobs for a candidate: the personality's `skill_evolution.promotion`
 * and `evolution_approval_mode`, and `~/.ethos/evolve-config.json`
 * `autoApprove` read fresh on every call (it used to be cached per process by
 * the fork). `autoApproveOverride` is `--auto-approve` on `ethos eval|evolve`:
 * it stands in for the global knob for that command only, so a personality's
 * own explicit `review` or `user` still wins.
 */
export function learningPolicyFor(
  ctx: LearningContext & { personalities: PersonalityLookup; autoApproveOverride?: boolean },
): (
  candidate: LearningCandidate,
) => Promise<{ knobs: AutoPromotionKnobs; scope: SkillScope | undefined }> {
  return async (candidate) => {
    const personality = ctx.personalities.get(candidate.personalityId);
    const globalAutoApprove =
      ctx.autoApproveOverride ??
      (await loadEvolveConfig(join(ctx.dataDir, 'evolve-config.json'), ctx.storage).then(
        (cfg) => cfg.autoApprove,
        () => false,
      ));
    return {
      knobs: {
        promotion: personality?.skill_evolution?.promotion,
        approvalMode: personality?.evolution_approval_mode,
        globalAutoApprove,
      },
      scope: personality?.skill_evolution?.scope,
    };
  };
}

/** Oldest first — the order the nightly step replays in. */
export async function pendingReplayCandidateIds(
  ctx: LearningContext,
  personalityId: string,
): Promise<string[]> {
  const pending = await listCandidates(ctx.storage, ctx.dataDir, {
    personalityId,
    status: 'pending_replay',
  });
  return pending.reverse().map((c) => c.id);
}

// --- Replay ------------------------------------------------------------------

export interface LearningReplayerOptions extends LearningContext {
  personalities: PersonalityLookup;
  expressions: ExpressionRevisions;
  /** The default LLM; grades `criteria` assertions (L-D5). */
  grader: LLMProvider;
  /** `resolveLearningReplay(config)` from `@ethosagent/config`. `enabled` is the caller's gate. */
  settings: { maxCases: number; maxCostUsd: number };
  workingDir?: string;
  /** Recorded on the audit line. */
  actor?: string;
  autoApproveOverride?: boolean;
}

/**
 * Replay a candidate on two real, isolated dry-run loops and let
 * `replayAndResolve` decide whether it promotes. L-D9 decides WHEN this is
 * called: the nightly `replay` step, or synchronously under `--auto-approve`.
 */
export function createLearningReplayer(
  config: WiringConfig,
  opts: LearningReplayerOptions,
): (candidateId: string) => Promise<ReplayAndResolveResult> {
  const { storage, dataDir } = opts;
  return (candidateId) =>
    replayAndResolve(
      {
        storage,
        dataDir,
        createArm: ({ shadow, session }) =>
          createReplayLoop(config, {
            dataDir,
            ...(opts.workingDir ? { workingDir: opts.workingDir } : {}),
            shadow,
            session,
          }),
        newSession: () => new InMemorySessionStore(),
        grader: opts.grader,
        runOptions: REPLAY_RUN_OPTIONS,
        settings: opts.settings,
        shadowFor: (candidate) => shadowForCandidate(candidate, { storage }),
        actor: opts.actor ?? 'replay',
        promote: learningPromoteDeps(opts),
        policyFor: learningPolicyFor(opts),
      },
      candidateId,
    );
}

// --- Review inbox (L-T8) ------------------------------------------------------

export interface LearningInboxOptions extends LearningContext {
  personalities: PersonalityLookup;
  expressions: ExpressionRevisions;
  /** The deployment's default personality, recorded on legacy queue files that carry none. */
  defaultPersonalityId: string | (() => Promise<string>);
  /** The `ethos audit decisions` sink. Absent (tests) → no `learning.*` rows. */
  observability?: LearningObservability;
  /** `createLearningReplayer(...)`. Absent → `replay` refuses `replay_unavailable`. */
  replay?: (candidateId: string) => Promise<ReplayAndResolveResult>;
}

/**
 * The review inbox bound to the real promote gates, the legacy drain (run once
 * on first use, so a web-only deployment drains the old queues too), and the
 * Living Soul parser for an Expression's "what is live now".
 */
export function createLearningInbox(opts: LearningInboxOptions): LearningInbox {
  return new LearningInbox({
    storage: opts.storage,
    dataDir: opts.dataDir,
    promote: learningPromoteDeps(opts),
    ...(opts.replay ? { replay: opts.replay } : {}),
    ...(opts.observability ? { observability: opts.observability } : {}),
    importLegacy: async () =>
      importLegacyLearningQueues({
        storage: opts.storage,
        dataDir: opts.dataDir,
        personalities: opts.personalities,
        defaultPersonalityId:
          typeof opts.defaultPersonalityId === 'string'
            ? opts.defaultPersonalityId
            : await opts.defaultPersonalityId(),
      }),
    current: async (candidate) => {
      const live = await opts.storage.read(candidate.destination);
      if (candidate.kind !== 'expression' || live === null) return { content: live, core: null };
      const soul = parseLivingSoul(live);
      return { content: soul.expression, core: soul.core };
    },
  });
}

/** A waiting skill candidate in the shape the old pending queue listed. `id` is the candidate id. */
export function toPendingSkillSummary(candidate: LearningCandidate): PendingSkillSummary {
  const parsed = parseSkillFrontmatter(candidate.content);
  const fm = parsed?.raw ?? {};
  return {
    id: candidate.id,
    name: typeof fm.name === 'string' ? fm.name : basename(candidate.destination, '.md'),
    description: typeof fm.description === 'string' ? fm.description : null,
    body: parsed?.body ?? candidate.content,
    proposedAt: candidate.submittedAt,
  };
}

/** The chat port lists and rejects skills; it never promotes, so no registry is needed. */
const NO_EXPRESSION_PROMOTION: ExpressionRevisions = {
  evolveExpression: async () => {
    throw new Error('Expression promotion is not reachable from the chat pending-skills port');
  },
  revertExpression: async () => {
    throw new Error('Expression rollback is not reachable from the chat pending-skills port');
  },
};

/**
 * `skills_pending_list / view / reject` over the inbox (L-D13: there is no
 * approve here). Ids are candidate ids — the same id `skills_pending_approve`'s
 * refusal tells the user to pass to `ethos learning approve`.
 */
export function learningPendingSkillsPort(
  ctx: LearningContext & {
    personalities: PersonalityLookup;
    defaultPersonalityId: string;
    observability?: LearningObservability;
  },
): PendingSkillsPort {
  const inbox = createLearningInbox({ ...ctx, expressions: NO_EXPRESSION_PROMOTION });
  return {
    listPending: async () =>
      (await inbox.list({ kind: 'skill', status: AWAITING_DECISION })).map(toPendingSkillSummary),
    rejectPending: async (id) => {
      const found = await inbox.resolve(id, { kind: 'skill' });
      if (!found.ok) throw new Error(found.reason);
      const rejected = await inbox.reject(found.value.id, { actor: 'chat', decidedBy: 'chat' });
      if (!rejected.ok) throw new Error(rejected.reason);
    },
  };
}

// --- Legacy import -----------------------------------------------------------

/**
 * Drain `skills/pending/`, flat `skills/.pending/`, `skills/.pending/<pid>/`
 * and B-T1's `learning/pending-expression/` into the inbox, once. Cheap on every
 * later call: `importLegacyQueues` returns at its marker file.
 */
export async function importLegacyLearningQueues(
  ctx: LearningContext & { personalities: PersonalityLookup; defaultPersonalityId: string },
): Promise<LegacyImportResult> {
  return importLegacyQueues({
    storage: ctx.storage,
    dataDir: ctx.dataDir,
    defaultPersonalityId: ctx.defaultPersonalityId,
    skillDestinationDir: (pid) =>
      liveSkillDir(ctx.dataDir, pid, ctx.personalities.get(pid)?.skill_evolution?.scope),
    soulFile: (pid) => soulFileOf(ctx, pid),
  });
}

// --- Cases -------------------------------------------------------------------

/** The personality's Core, for the session-turn assertion. Empty when there is no SOUL.md. */
export async function personalityCore(
  ctx: LearningContext & { personalities: PersonalityLookup },
  personalityId: string,
): Promise<string> {
  const soulFile = ctx.personalities.get(personalityId)?.soulFile;
  if (!soulFile) return '';
  const body = await ctx.storage.read(soulFile);
  return body === null ? '' : parseLivingSoul(body).core;
}

function isPlainText(m: StoredMessage): boolean {
  return (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0;
}

/** Each user message with up to 4 preceding plain-text messages. Oldest first. */
function turnsOf(sessionKey: string, messages: readonly StoredMessage[]): SessionCaseTurn[] {
  const plain = messages.filter(isPlainText);
  const turns: SessionCaseTurn[] = [];
  plain.forEach((m, i) => {
    if (m.role !== 'user') return;
    turns.push({
      sessionKey,
      messageId: m.id,
      prompt: m.content,
      context: plain.slice(Math.max(0, i - CASE_CONTEXT_MESSAGES), i).map((c) => c.content),
    });
  });
  return turns;
}

/**
 * Freeze the latest user turn of a session as a case and return its id — the
 * triggering turn for a fork or chat proposal. Null when the session key is one
 * of `LEARNING_EXCLUDED_KEY_PREFIXES` (X-D7) or there is no user turn.
 */
export async function freezeLatestUserTurnCase(
  ctx: LearningContext & { personalities: PersonalityLookup },
  sessions: Pick<CaseSessionSource, 'getMessages'>,
  turn: { sessionId: string; sessionKey: string; personalityId: string },
): Promise<string | null> {
  const turns = turnsOf(turn.sessionKey, await sessions.getMessages(turn.sessionId, { limit: 20 }));
  const latest = turns.at(-1);
  if (!latest) return null;
  const core = await personalityCore(ctx, turn.personalityId);
  const frozenAt = new Date().toISOString();
  const learningCase = caseFromSessionTurn(turn.personalityId, latest, core, frozenAt);
  if (!learningCase) return null;
  await freezeCase(ctx.storage, ctx.dataDir, learningCase);
  return learningCase.id;
}

/** Recent real user turns for a personality, newest sessions first, excluded keys filtered at the query. */
async function recentSessionTurns(
  sessions: CaseSessionSource,
  personalityId: string,
  maxSessions = 10,
): Promise<SessionCaseTurn[]> {
  const listed = await sessions.listSessions({
    personalityId,
    excludeKeyPrefixes: [...LEARNING_EXCLUDED_KEY_PREFIXES],
  });
  listed.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const turns: SessionCaseTurn[] = [];
  for (const s of listed.slice(0, maxSessions)) {
    turns.push(...turnsOf(s.key, await sessions.getMessages(s.id, { limit: 20 })).reverse());
  }
  return turns;
}

/**
 * Freeze (or find) cases for the most recent user turns of a personality and
 * return their ids — the target cases for a nightly draft built from those
 * sessions. At most `limit`.
 */
export async function freezeRecentSessionCases(
  ctx: LearningContext & { personalities: PersonalityLookup },
  sessions: CaseSessionSource,
  personalityId: string,
  limit = 3,
): Promise<string[]> {
  const core = await personalityCore(ctx, personalityId);
  const frozenAt = new Date().toISOString();
  const ids: string[] = [];
  for (const turn of await recentSessionTurns(sessions, personalityId)) {
    if (ids.length >= limit) break;
    const learningCase = caseFromSessionTurn(personalityId, turn, core, frozenAt);
    if (!learningCase) continue;
    await freezeCase(ctx.storage, ctx.dataDir, learningCase);
    ids.push(learningCase.id);
  }
  return ids;
}

/**
 * The nightly freeze pass for one personality (Design section 2): done kanban
 * tickets assigned to it first, then recent session turns. At most 10 new
 * cases; the pool is trimmed to 40 (`captureCases`).
 *
 * The board is opened only when its file already exists — `new KanbanStore`
 * creates the database, and a freeze pass must not leave a `board.db` on every
 * machine that never used kanban.
 */
export async function freezeNightlyCases(
  ctx: LearningContext & { personalities: PersonalityLookup },
  opts: { personalityId: string; sessions?: CaseSessionSource; kanbanDbPath?: string },
): Promise<CaptureCasesResult> {
  const { personalityId } = opts;
  return captureCases({
    storage: ctx.storage,
    dataDir: ctx.dataDir,
    personalityId,
    core: await personalityCore(ctx, personalityId),
    kanbanTasks: async (): Promise<KanbanCaseTask[]> => {
      if (!opts.kanbanDbPath || !(await ctx.storage.exists(opts.kanbanDbPath))) return [];
      const board = new KanbanStore(opts.kanbanDbPath);
      try {
        return board
          .listTasks({ assignee: personalityId, status: 'done' })
          .filter((t) => t.acceptanceCriteria)
          .map((t) => ({
            id: t.id,
            title: t.title,
            body: t.body,
            acceptanceCriteria: t.acceptanceCriteria,
          }));
      } finally {
        board.close();
      }
    },
    sessionTurns: async () =>
      opts.sessions ? recentSessionTurns(opts.sessions, personalityId) : [],
  });
}
