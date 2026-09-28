// Governed self-amendment (plan personality-memory-boundary-and-self-amendment,
// G2): the FILING intake ("The intake") and the owner's review service
// ("Apply, decline, rollback", `createAmendmentService`, below the intake).
//
// `createAmendmentIntake` implements the `AmendmentSubmitPort` the
// `propose_self_amendment` tool holds (extensions/tools-personality-design/src/
// propose-amendment.ts). It only files: it writes a `pending` (or
// `auto_rejected`) record into the amendment store (`@ethosagent/learning-inbox`
// `createAmendment`) and never touches the personality's `toolset.yaml`. Apply,
// decline and rollback are `AmendmentService`, which shares no code path with
// the port: the tool is handed the intake alone (compose-tools.ts), and the
// service is returned to the HOST beside the loop (`CreateAgentLoopResult.
// amendments`), whose only caller that applies is the TTY-gated CLI (G2-1 (c)).
//
// The checks run in the plan's order, and each refusal returns a reason and
// writes nothing — except a constitution violation, which is recorded as
// `auto_rejected` with an `amendment.auto_reject` approval row (D29):
//   1. who and where (D23)   — `gateRefusal`
//   2. taint                 — `taintRefusal`
//   3. opt-in                — the live `toolset.yaml` lists the tool itself
//   4. target (D25)          — not a built-in
//   5. ops                   — `opsRefusal`, then `applyOps`
//   6. evidence (D26)        — `collectEvidence`
//   7. lock, limits, constitution — under `amendmentApplyLockPath`
// Every row is pinned by packages/wiring/src/__tests__/propose-amendment.test.ts.

import { dirname, join, sep } from 'node:path';
import {
  ConstitutionViolationError,
  enforceConstitution,
  loadConstitution,
} from '@ethosagent/constitution';
import { reconstructFromWatermark, selectActiveWatermark } from '@ethosagent/core';
import {
  type AmendmentFilter,
  type AmendmentOpsRefusal,
  amendmentAppliedPath,
  amendmentApplyLockPath,
  amendmentPriorPath,
  applyOps,
  checkPendingLimits,
  createAmendment,
  expectedAfterHash,
  listAmendments,
  opsHash,
  readAmendment,
  transitionAmendment,
} from '@ethosagent/learning-inbox';
import {
  createPersonalityRegistry,
  DefinitionChangedError,
  type DescribedPersonality,
  diffPermissionSurface,
  type FilePersonalityRegistry,
  hashDefinitionBytes,
  notComparedLine,
  type PermissionDiff,
  permissionSurface,
} from '@ethosagent/personalities';
import { redactString } from '@ethosagent/safety-redact';
import { PROPOSE_SELF_AMENDMENT_TOOL } from '@ethosagent/tools-personality-design';
import {
  type AmendmentActor,
  type AmendmentEvidence,
  type AmendmentFlag,
  type AmendmentOp,
  type AmendmentPreCheck,
  type AmendmentRecord,
  type AmendmentSubmitInput,
  type AmendmentSubmitPort,
  type AmendmentSubmitResult,
  type ExecutionPosture,
  type Logger,
  type PersonalityConfig,
  type PersonalityRegistry,
  parseToolsetYaml,
  type SessionStore,
  type Storage,
  type StoredMessage,
  type ToolContext,
  type ToolRegistry,
} from '@ethosagent/types';
import { acquireSentinelLock } from './backup/sentinel-lock';

/** The one refusal a tainted context gets (plan G2, intake check 2). */
export const AMENDMENT_TAINT_REFUSAL =
  'this conversation has untrusted content in its context — file this from a fresh session';

/** Longest evidence excerpt stored on a record. */
const EVIDENCE_EXCERPT_CHARS = 300;

/** How long a filing waits for `.apply.lock` before refusing. */
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 50;
/** A lock body with no readable holder is stale past this age. */
const UNREADABLE_LOCK_STALE_MS = 60_000;

/** Session-key prefixes a filing may come from (D23): the owner's CLI and web app. */
const FILING_KEY_PREFIXES = ['cli:', 'web:'] as const;

/**
 * Take the amendment store's advisory lock; resolves to its `release`.
 *
 * A caller of `acquireSentinelLock` (packages/wiring/src/backup/sentinel-lock.ts),
 * which holds the raw `node:fs` calls and the stale-holder protocol. Filing
 * holds it across the limit check, the dedupe and the write, so two filings
 * cannot both pass the 3-pending limit; apply, decline and rollback
 * (`createAmendmentService`) take the same lock, so no two of the four
 * interleave. A contended filing waits `LOCK_WAIT_MS`, then refuses
 * with nothing written.
 */
export async function acquireAmendmentLock(
  dataDir: string,
  timeoutMs: number = LOCK_WAIT_MS,
): Promise<() => void> {
  const lockPath = amendmentApplyLockPath(dataDir);
  return await acquireSentinelLock({
    lockPath,
    timeoutMs,
    retryMs: LOCK_RETRY_MS,
    unreadableStaleMs: UNREADABLE_LOCK_STALE_MS,
    refusal: (pid) =>
      `amendments: ${lockPath} is still held${pid === null ? '' : ` by process ${pid}`} after ` +
      `${timeoutMs}ms, so nothing was changed. ` +
      (pid === null
        ? 'If no Ethos process is running, delete that file.'
        : `Only once process ${pid} is confirmed gone (\`ps -p ${pid}\`), delete ${lockPath}.`),
  });
}

/** The audit sink, declared structurally — `EthosObservability` satisfies it. */
export interface AmendmentObservability {
  recordSafetyApproval(opts: {
    decision: 'approved' | 'denied' | 'auto';
    severity?: 'info' | 'warn';
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
}

export interface AmendmentIntakeDeps {
  /** Unscoped Storage: the store lives under `learning/`, which every turn's ScopedStorage denies. */
  storage: Storage;
  /** `~/.ethos` (or `ETHOS_STATE_DIR`). */
  dataDir: string;
  /** Passed to `enforceConstitution` for `${CWD}` substitution. */
  workingDir: string;
  personalities: Pick<PersonalityRegistry, 'get'>;
  tools: Pick<ToolRegistry, 'get' | 'getPluginId'>;
  sessions: Pick<SessionStore, 'getSession' | 'getMessages' | 'listCompressions'>;
  /** The resolved execution posture, recorded in provenance. Absent → `'none'`. */
  executionPostureFor?: (personalityId: string) => ExecutionPosture | undefined;
  observability?: AmendmentObservability;
  log: Logger;
  /** Injectable for tests; defaults to {@link acquireAmendmentLock}. */
  acquireLock?: (dataDir: string) => Promise<() => void>;
  now?: () => number;
}

const refuse = (reason: string): AmendmentSubmitResult => ({ ok: false, reason });

/**
 * Check 1 (D23): a person started this turn, in a private room, on the owner's
 * CLI or cookie-authenticated web app, as a top-level foreground turn.
 *
 * `initiator === 'user'` is set only by attended surfaces: the CLI REPL
 * (apps/ethos/src/commands/chat.ts), the TUI (apps/tui/src/components/App.tsx),
 * web chat for a COOKIE session (apps/web-api/src/features/chat/rpc/send.ts —
 * a bearer key gets `'system'`) and the gateway for a real inbound message.
 * The key-prefix check is the second lock: it drops gateway DMs (owner DMs are
 * v1.1) and `acp:`, which mesh peers open.
 */
export function gateRefusal(ctx: ToolContext): string | null {
  if (!ctx.personalityId) return 'this turn has no personality to amend';
  if (ctx.initiator !== 'user') return 'only a turn a person started can file an amendment';
  if (ctx.roomAudience !== 'private')
    return 'amendments are filed only from a private conversation';
  if (!FILING_KEY_PREFIXES.some((prefix) => ctx.sessionKey.startsWith(prefix))) {
    return 'amendments are filed only from the owner CLI or the web app';
  }
  if (ctx.jobId) return 'a background job cannot file an amendment';
  if (ctx.reviewOfJobId) return 'a job review turn cannot file an amendment';
  if (ctx.agentId?.startsWith('depth:')) return 'a delegated sub-agent cannot file an amendment';
  if (ctx.dryRun) return 'a dry run cannot file an amendment';
  return null;
}

/**
 * Check 2: nothing untrusted is in the context the model saw — this session's
 * stored messages from the active compaction watermark on (the same
 * `reconstructFromWatermark` the loop's context assembly uses; the scan reads
 * every stored message rather than the loop's `historyLimit` tail, so it can
 * only refuse more, never less). Tainted by:
 * - an attachment on this turn or on any user message in the window;
 * - a successful result from a tool whose `outputIsUntrusted` is set — looked
 *   up by name, because stored rows do not record the flag;
 * - any `mcp__*` result, any result from a tool no longer registered, and any
 *   result with no tool name.
 * A result recorded as an error (`isError === true`) is skipped: core wraps
 * only SUCCESS output as untrusted (`Tool.outputIsUntrusted`), and a refused
 * call is exactly the evidence check 6 accepts. An unrecorded status is not
 * skipped.
 */
export async function taintRefusal(
  deps: Pick<AmendmentIntakeDeps, 'sessions' | 'tools'>,
  ctx: ToolContext,
): Promise<string | null> {
  if ((ctx.attachments?.list().length ?? 0) > 0) return AMENDMENT_TAINT_REFUSAL;
  const history = (await deps.sessions.getMessages(ctx.sessionId)).filter(
    (m) => m.role !== 'system',
  );
  const watermark = selectActiveWatermark(await deps.sessions.listCompressions(ctx.sessionId));
  const window = watermark ? reconstructFromWatermark(history, watermark).history : history;
  for (const message of window) {
    if (isTainted(deps.tools, message)) return AMENDMENT_TAINT_REFUSAL;
  }
  return null;
}

function isTainted(tools: Pick<ToolRegistry, 'get'>, message: StoredMessage): boolean {
  if (message.role === 'user' || message.role === 'user_steer') {
    return (message.contentBlocks?.length ?? 0) > 0 || message.content.includes('<attachments>');
  }
  if (message.role !== 'tool_result' || message.isError === true) return false;
  const name = message.toolName;
  if (!name || name.startsWith('mcp__')) return true;
  const tool = tools.get(name);
  return !tool || tool.outputIsUntrusted === true;
}

const OPS_REFUSAL: Record<AmendmentOpsRefusal['reason'], string> = {
  empty: 'no operations were given',
  too_many: 'too many operations',
  invalid_op: 'an operation names an invalid tool',
  conflict: 'the same tool is both added and removed',
  undeclared_toolset: 'this personality has no declared toolset',
  no_op: 'an operation would change nothing',
};

function describeOpsRefusal(refusal: AmendmentOpsRefusal): string {
  const base = OPS_REFUSAL[refusal.reason];
  return 'tool' in refusal ? `${base} (${refusal.tool})` : base;
}

/**
 * Check 5, the registry half: each op names a registered, toolset-gated tool.
 * MCP and plugin tools are gated by `mcp_servers`/`plugins`, not the toolset,
 * and an `alwaysInclude` tool ignores the toolset — so none of them can be
 * amended here (v1).
 */
function opsRefusal(
  tools: AmendmentIntakeDeps['tools'],
  ops: readonly AmendmentOp[],
): string | null {
  for (const { tool } of ops) {
    if (tool.startsWith('mcp__')) return `MCP tools are not amendable (${tool})`;
    const registered = tools.get(tool);
    if (!registered) return `no tool named ${tool} is registered`;
    if (tools.getPluginId?.(tool)) return `plugin tools are not amendable (${tool})`;
    if (registered.alwaysInclude) return `${tool} is always available and is not toolset-gated`;
  }
  return null;
}

/** Check 6 (D26): each cited id is a refused tool call in this personality's own session. */
async function collectEvidence(
  deps: Pick<AmendmentIntakeDeps, 'sessions'>,
  ctx: ToolContext,
  personalityId: string,
  ids: readonly string[],
): Promise<AmendmentEvidence[] | string> {
  if (ids.length === 0) return [];
  const session = await deps.sessions.getSession(ctx.sessionId);
  if (!session || session.personalityId !== personalityId) {
    return 'evidence must come from this personality’s own conversation';
  }
  const messages = await deps.sessions.getMessages(ctx.sessionId);
  const evidence: AmendmentEvidence[] = [];
  for (const id of new Set(ids)) {
    const row = messages.find((m) => m.role === 'tool_result' && m.toolCallId === id);
    if (!row) return `no tool call ${id} in this conversation`;
    if (row.isError !== true) return `tool call ${id} was not refused`;
    evidence.push({
      sessionId: ctx.sessionId,
      toolCallId: id,
      toolName: row.toolName ?? 'unknown',
      messageId: row.id,
      excerpt: redactString(row.content).slice(0, EVIDENCE_EXCERPT_CHARS),
    });
  }
  return evidence;
}

/** A shell or code runner — the tools that make a `local` posture able to edit its own files. */
function isShellTool(tool: string): boolean {
  return tool === 'terminal' || tool === 'run_code' || tool.startsWith('process_');
}

/** Where `writeDefinitionBytes` writes: the directory of the personality's SOUL.md. */
function toolsetPathOf(config: PersonalityConfig): string | null {
  return config.soulFile ? join(dirname(config.soulFile), 'toolset.yaml') : null;
}

/**
 * D25: user-owned means loaded from `<dataDir>/personalities/` — the directory
 * the composition root loads user personalities from
 * (extensions/personalities/src/compose.ts). This is the predicate
 * `FilePersonalityRegistry.toDescribed` computes as `builtin`, restated here
 * because the composition root's registry is built without a
 * `userPersonalitiesDir`, so its own `describe(id).builtin` is true for every
 * personality. A personality with no SOUL.md path cannot be located, so it is
 * not user-owned either.
 */
function isUserOwned(config: PersonalityConfig, dataDir: string): boolean {
  return config.soulFile?.startsWith(`${join(dataDir, 'personalities')}${sep}`) ?? false;
}

/** The filing intake. See the file header for the check order. */
export function createAmendmentIntake(deps: AmendmentIntakeDeps): AmendmentSubmitPort {
  const now = deps.now ?? Date.now;
  const acquireLock = deps.acquireLock ?? ((dataDir: string) => acquireAmendmentLock(dataDir));

  return {
    async submit(input: AmendmentSubmitInput, ctx: ToolContext): Promise<AmendmentSubmitResult> {
      // 1. Who and where.
      const gate = gateRefusal(ctx);
      if (gate) return refuse(gate);
      const personalityId = ctx.personalityId ?? '';

      // 2. Taint.
      const taint = await taintRefusal(deps, ctx);
      if (taint) return refuse(taint);

      // 3. Opt-in: the LIVE toolset.yaml declares a toolset and lists this tool.
      const config = deps.personalities.get(personalityId);
      const toolsetPath = config ? toolsetPathOf(config) : null;
      if (!config || !toolsetPath) return refuse(`personality ${personalityId} was not found`);
      const liveBytes = await deps.storage.read(toolsetPath);
      if (!liveBytes || parseToolsetYaml(liveBytes).length === 0) {
        return refuse('this personality has no declared toolset; declare one by hand first');
      }
      if (!parseToolsetYaml(liveBytes).includes(PROPOSE_SELF_AMENDMENT_TOOL)) {
        return refuse(
          `this personality has not opted in (its toolset does not list ${PROPOSE_SELF_AMENDMENT_TOOL})`,
        );
      }

      // 4. Target (D25).
      if (!isUserOwned(config, deps.dataDir)) {
        return refuse(
          `${personalityId} is a built-in personality; duplicate it first and amend the copy`,
        );
      }

      // 5. Ops.
      const registryRefusal = opsRefusal(deps.tools, input.ops);
      if (registryRefusal) return refuse(registryRefusal);
      const applied = applyOps(liveBytes, input.ops);
      if (!applied.ok) return refuse(describeOpsRefusal(applied));

      // 6. Evidence.
      const evidence = await collectEvidence(
        deps,
        ctx,
        personalityId,
        input.evidenceToolCallIds ?? [],
      );
      if (typeof evidence === 'string') return refuse(evidence);

      // 7. Lock, limits, constitution.
      let release: () => void;
      try {
        release = await acquireLock(deps.dataDir);
      } catch (err) {
        return refuse(err instanceof Error ? err.message : String(err));
      }
      try {
        // The bytes the ops were checked against must still be live.
        const lockedBytes = await deps.storage.read(toolsetPath);
        if (lockedBytes !== liveBytes) return refuse('the toolset changed while filing; try again');

        const hashOfOps = opsHash(applied.ops);
        const limits = await checkPendingLimits(
          deps.storage,
          deps.dataDir,
          personalityId,
          hashOfOps,
        );
        if (limits.kind === 'duplicate') {
          return { ok: true, id: limits.existing.id, status: 'pending', deduped: true };
        }
        if (limits.kind === 'limit') {
          return refuse(`this personality already has ${limits.pending} pending amendments`);
        }

        const constitution = await loadConstitution(deps.storage, deps.dataDir);
        if (constitution.status === 'malformed') {
          return refuse(
            `the constitution is malformed, so nothing can be filed (${constitution.error})`,
          );
        }
        let preCheck: AmendmentPreCheck = 'ok';
        try {
          // A clone: `enforceConstitution` clamps `budgetCapUsd` in place.
          const after = { ...structuredClone(config), toolset: applied.after };
          enforceConstitution({
            constitution: constitution.constitution,
            personalities: [after],
            ethosHome: deps.dataDir,
            workingDir: deps.workingDir,
            log: deps.log,
          });
        } catch (err) {
          if (!(err instanceof ConstitutionViolationError)) throw err;
          preCheck = { reason: err.message };
        }

        const created = await createAmendment(
          deps.storage,
          deps.dataDir,
          {
            personalityId,
            ops: applied.ops,
            baseHash: hashDefinitionBytes(liveBytes),
            rationale: input.rationale,
            evidence,
            provenance: {
              sessionId: ctx.sessionId,
              sessionKey: ctx.sessionKey,
              platform: ctx.platform,
              ...(ctx.origin ? { origin: ctx.origin } : {}),
              initiator: 'user',
              roomAudience: 'private',
              executionPosture: deps.executionPostureFor?.(personalityId)?.backend ?? 'none',
              holdsShellTool: parseToolsetYaml(liveBytes).some(isShellTool),
            },
            preCheck,
            status: preCheck === 'ok' ? 'pending' : 'auto_rejected',
          },
          now,
        );
        if (created.kind === 'duplicate') {
          return { ok: true, id: created.record.id, status: 'pending', deduped: true };
        }
        if (created.kind === 'limit') {
          return refuse(`this personality already has ${created.pending} pending amendments`);
        }
        const record = created.record;
        if (typeof preCheck === 'object') {
          deps.observability?.recordSafetyApproval({
            decision: 'denied',
            severity: 'warn',
            code: 'amendment.auto_reject',
            cause: preCheck.reason,
            details: { amendmentId: record.id, personalityId, ops: record.ops },
          });
          return {
            ok: true,
            id: record.id,
            status: 'auto_rejected',
            deduped: false,
            reason: preCheck.reason,
          };
        }
        return { ok: true, id: record.id, status: 'pending', deduped: false };
      } finally {
        release();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The review service: list, get, apply, decline, rollback (plan G2, "Apply,
// decline, rollback"). No filing path: it cannot create a record, and the
// `propose_self_amendment` tool is never handed it (compose-tools.ts passes
// the intake alone). Every mutation holds `.apply.lock`
// (`acquireAmendmentLock`), the lock filing holds too.
// ---------------------------------------------------------------------------

/**
 * The registry the service reads and writes through. It MUST be a
 * `FilePersonalityRegistry` built with `userPersonalitiesDir` set to the data
 * dir: only then does `describe(id).builtin` tell a user personality from a
 * built-in, and only then does `writeDefinitionBytes` accept a user one (the
 * loop's own registry is built without a user dir, so to it everything is
 * built-in). `amendmentPersonalityLoader` builds one.
 */
export type AmendmentPersonalities = Pick<
  FilePersonalityRegistry,
  'describe' | 'writeDefinitionBytes'
>;

/**
 * A loader that re-reads `<dataDir>/personalities/` into one user-dir-aware
 * `FilePersonalityRegistry` and returns it. The registry is built on first
 * use — only a host that reviews amendments pays for it — and refreshed on
 * every call (mtime-cached), so each operation sees the live definitions.
 */
export function amendmentPersonalityLoader(opts: {
  storage: Storage;
  dataDir: string;
  builtinPersonalitiesDir?: string;
}): () => Promise<AmendmentPersonalities> {
  let registry: Promise<FilePersonalityRegistry> | undefined;
  return async () => {
    registry ??= createPersonalityRegistry({
      storage: opts.storage,
      userPersonalitiesDir: opts.dataDir,
      ...(opts.builtinPersonalitiesDir
        ? { builtinPersonalitiesDir: opts.builtinPersonalitiesDir }
        : {}),
    });
    let loaded: FilePersonalityRegistry;
    try {
      loaded = await registry;
    } catch (err) {
      registry = undefined; // a failed build is retried on the next call, not cached
      throw err;
    }
    await loaded.loadFromDirectory(join(opts.dataDir, 'personalities'));
    return loaded;
  };
}

export interface AmendmentServiceDeps {
  /** Unscoped Storage, as for the intake. */
  storage: Storage;
  dataDir: string;
  /** Passed to `enforceConstitution` for `${CWD}` substitution. */
  workingDir: string;
  /** See {@link AmendmentPersonalities}; called once per operation. */
  loadPersonalities: () => Promise<AmendmentPersonalities>;
  /** Re-validates the ops (still registered, still toolset-gated) and the `tool-unavailable` flag. */
  tools: Pick<ToolRegistry, 'get' | 'getPluginId'>;
  /** The live execution posture, for the `local-terminal` flag. Absent → `'none'`. */
  executionPostureFor?: (personalityId: string) => ExecutionPosture | undefined;
  observability?: AmendmentObservability;
  log: Logger;
  /** Injectable for tests; defaults to {@link acquireAmendmentLock}. */
  acquireLock?: (dataDir: string) => Promise<() => void>;
  now?: () => number;
}

/** What `get` shows a reviewer. Everything but `record` is recomputed from live state. */
export interface AmendmentReview {
  record: AmendmentRecord;
  /** The personality still loads and is user-owned (the only kind apply writes). */
  personality: 'ok' | 'not_found' | 'builtin';
  /** The live `toolset.yaml` bytes; `null` when the file (or the personality) is gone. */
  liveBytes: string | null;
  liveHash: string | null;
  /** The live file is not the bytes the proposal was filed against — apply would go `stale`. */
  stale: boolean;
  /**
   * An apply wrote `applied.json` and the live file already holds exactly the
   * after-bytes of its prior snapshot, but the record never reached `applied`
   * — the process died between the live write and the status update. The plan
   * leaves recovery to the owner in v1: apply answers `stale`, and the owner
   * closes it with `decline`.
   */
  interruptedApply: boolean;
  /** `applyOps` on the LIVE bytes; `null` when the ops no longer apply (`opsProblem`). */
  afterBytes: string | null;
  opsProblem?: string;
  /**
   * `sha256(baseHash ‖ opsHash ‖ afterBytes)` over the live after-bytes — the
   * value apply must be handed (G2-5). `null` when there is nothing to apply.
   */
  expectedAfterHash: string | null;
  /** Line diff of `toolset.yaml`, live → after: each line prefixed `' '`, `'-'` or `'+'`. */
  textDiff: string[];
  permissionDiff: PermissionDiff | null;
  /** `Not compared: …` — printed beside the permission diff (D27). */
  notCompared: string;
  flags: AmendmentFlag[];
}

export type AmendmentActionCode =
  | 'not_found'
  | 'not_pending'
  | 'not_applied'
  | 'personality_not_found'
  | 'builtin'
  | 'stale'
  | 'hash_mismatch'
  | 'auto_rejected'
  | 'constitution_violation'
  | 'constitution_malformed'
  | 'live_edited'
  | 'prior_missing'
  | 'reason_required'
  | 'locked';

/** An action's answer. `ok: false` with a `record` means the record itself moved (`stale`, `auto_rejected`). */
export type AmendmentActionResult =
  | { ok: true; record: AmendmentRecord }
  | { ok: false; code: AmendmentActionCode; reason: string; record?: AmendmentRecord };

export interface AmendmentService {
  /** Newest first (`listAmendments`). */
  list(filter?: AmendmentFilter): Promise<AmendmentRecord[]>;
  get(id: string): Promise<AmendmentReview | null>;
  apply(
    id: string,
    opts: { actor: AmendmentActor; decidedBy: string; expectedAfterHash: string },
  ): Promise<AmendmentActionResult>;
  decline(
    id: string,
    opts: { actor: AmendmentActor; decidedBy: string; reason: string },
  ): Promise<AmendmentActionResult>;
  rollback(
    id: string,
    opts: { actor: AmendmentActor; decidedBy: string },
  ): Promise<AmendmentActionResult>;
}

/** Body of `applied.json`, written before the live write (the `promote.ts` order). */
interface AppliedMarker {
  amendmentId: string;
  personalityId: string;
  priorHash: string;
  afterHash: string;
  at: string;
}

type ConstitutionOutcome =
  | { kind: 'ok' }
  | { kind: 'violation'; reason: string }
  | { kind: 'malformed'; error: string };

/**
 * The constitution over a CLONE of `config` with `toolset` swapped in —
 * `enforceConstitution` clamps `budgetCapUsd` in place, and the registry hands
 * out live references (G2-3).
 */
async function checkConstitution(
  deps: Pick<AmendmentServiceDeps, 'storage' | 'dataDir' | 'workingDir' | 'log'>,
  config: PersonalityConfig,
  toolset: string[],
): Promise<ConstitutionOutcome> {
  const constitution = await loadConstitution(deps.storage, deps.dataDir);
  if (constitution.status === 'malformed') return { kind: 'malformed', error: constitution.error };
  try {
    enforceConstitution({
      constitution: constitution.constitution,
      personalities: [{ ...structuredClone(config), toolset }],
      ethosHome: deps.dataDir,
      workingDir: deps.workingDir,
      log: deps.log,
    });
  } catch (err) {
    if (!(err instanceof ConstitutionViolationError)) throw err;
    return { kind: 'violation', reason: err.message };
  }
  return { kind: 'ok' };
}

/** Longest-common-subsequence line diff; `toolset.yaml` is a short list, so O(n·m) is fine. */
function lineDiff(before: string, after: string): string[] {
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const b = after === '' ? [] : after.replace(/\n$/, '').split('\n');
  const width = b.length + 1;
  const lcs = new Array<number>((a.length + 1) * width).fill(0);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      out.push(`-${a[i]}`);
      i++;
    } else {
      out.push(`+${b[j]}`);
      j++;
    }
  }
  for (; i < a.length; i++) out.push(`-${a[i]}`);
  for (; j < b.length; j++) out.push(`+${b[j]}`);
  return out;
}

/**
 * The review flags, from live state (types: `AmendmentFlag`).
 * - `tool-unavailable` — an added tool is registered but `isAvailable()` is false.
 * - `no-recorded-refusal` — no evidence was cited (D26).
 * - `local-terminal` — a shell tool under a `local` posture, either as recorded
 *   at filing or now (live posture, with the live or the after toolset). Such a
 *   personality can already edit its own files and run the CLI (G2-1's
 *   exception), so the owner is told.
 * - `high-risk` / `team-workflow` — the permission diff's own row flags.
 */
export function amendmentFlags(input: {
  record: AmendmentRecord;
  tools: Pick<ToolRegistry, 'get'>;
  livePosture: ExecutionPosture['backend'];
  liveToolset: readonly string[];
  afterToolset: readonly string[];
  permissionDiff: PermissionDiff | null;
}): AmendmentFlag[] {
  const { record, tools } = input;
  const flags = new Set<AmendmentFlag>();
  for (const { op, tool } of record.ops) {
    if (op === 'add_tool' && tools.get(tool)?.isAvailable?.() === false) {
      flags.add('tool-unavailable');
    }
  }
  if (record.evidence.length === 0) flags.add('no-recorded-refusal');
  const recordedLocalShell =
    record.provenance.executionPosture === 'local' && record.provenance.holdsShellTool;
  const liveLocalShell =
    input.livePosture === 'local' &&
    (input.liveToolset.some(isShellTool) || input.afterToolset.some(isShellTool));
  if (recordedLocalShell || liveLocalShell) flags.add('local-terminal');
  for (const change of input.permissionDiff?.changes ?? []) {
    if (change.flag) flags.add(change.flag);
  }
  return [...flags];
}

/** Where the live file is — recomputed from the personality id on every call, never read from a record (G2-8). */
function liveToolsetPath(described: DescribedPersonality): string | null {
  return toolsetPathOf(described.config);
}

/** The review service. See the section header above. */
export function createAmendmentService(deps: AmendmentServiceDeps): AmendmentService {
  const now = deps.now ?? Date.now;
  const acquireLock = deps.acquireLock ?? ((dataDir: string) => acquireAmendmentLock(dataDir));
  const livePosture = (personalityId: string): ExecutionPosture['backend'] =>
    deps.executionPostureFor?.(personalityId)?.backend ?? 'none';

  async function locked(fn: () => Promise<AmendmentActionResult>): Promise<AmendmentActionResult> {
    let release: () => void;
    try {
      release = await acquireLock(deps.dataDir);
    } catch (err) {
      return {
        ok: false,
        code: 'locked',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** The personality an action writes, or the refusal. Built-ins are never written (D25). */
  async function mutableTarget(
    record: AmendmentRecord,
  ): Promise<
    | { ok: true; registry: AmendmentPersonalities; described: DescribedPersonality; path: string }
    | { ok: false; result: AmendmentActionResult }
  > {
    const registry = await deps.loadPersonalities();
    const described = registry.describe(record.personalityId);
    const path = described ? liveToolsetPath(described) : null;
    if (!described || !path) {
      return {
        ok: false,
        result: {
          ok: false,
          code: 'personality_not_found',
          reason: `personality ${record.personalityId} was not found`,
        },
      };
    }
    if (described.builtin) {
      return {
        ok: false,
        result: {
          ok: false,
          code: 'builtin',
          reason: `${record.personalityId} is a built-in personality and cannot be changed`,
        },
      };
    }
    return { ok: true, registry, described, path };
  }

  /** True when an earlier apply of this record wrote the live file but never recorded it. */
  async function interruptedApply(record: AmendmentRecord, liveHash: string | null) {
    if (liveHash === null) return false;
    const marker = await deps.storage.read(amendmentAppliedPath(deps.dataDir, record.id));
    const prior = await deps.storage.read(amendmentPriorPath(deps.dataDir, record.id));
    if (marker === null || prior === null) return false;
    const after = applyOps(prior, record.ops);
    return after.ok && hashDefinitionBytes(after.afterBytes) === liveHash;
  }

  async function markStale(
    record: AmendmentRecord,
    decidedBy: string,
    actor: AmendmentActor,
    reason: string,
  ): Promise<AmendmentActionResult> {
    const next = await transitionAmendment(
      deps.storage,
      deps.dataDir,
      record.id,
      { to: 'stale', actor, decidedBy, reason },
      now,
    );
    return { ok: false, code: 'stale', reason, record: next };
  }

  return {
    list: (filter) => listAmendments(deps.storage, deps.dataDir, filter),

    async get(id) {
      const record = await readAmendment(deps.storage, deps.dataDir, id);
      if (!record) return null;
      const registry = await deps.loadPersonalities();
      const described = registry.describe(record.personalityId);
      const path = described ? liveToolsetPath(described) : null;
      const liveBytes = path ? await deps.storage.read(path) : null;
      const liveHash = liveBytes === null ? null : hashDefinitionBytes(liveBytes);
      const review: AmendmentReview = {
        record,
        personality: !described || !path ? 'not_found' : described.builtin ? 'builtin' : 'ok',
        liveBytes,
        liveHash,
        stale: liveHash !== record.baseHash,
        interruptedApply: await interruptedApply(record, liveHash),
        afterBytes: null,
        expectedAfterHash: null,
        textDiff: [],
        permissionDiff: null,
        notCompared: notComparedLine(),
        flags: [],
      };
      const liveToolset = liveBytes === null ? [] : parseToolsetYaml(liveBytes);
      let afterToolset: string[] = liveToolset;
      if (described && (record.status === 'pending' || record.status === 'stale')) {
        const registryProblem = opsRefusal(deps.tools, record.ops);
        const after = applyOps(liveBytes, record.ops);
        if (registryProblem) review.opsProblem = registryProblem;
        else if (!after.ok) review.opsProblem = describeOpsRefusal(after);
        if (after.ok && !registryProblem) {
          afterToolset = after.after;
          review.afterBytes = after.afterBytes;
          review.expectedAfterHash = expectedAfterHash(
            record.baseHash,
            opsHash(after.ops),
            after.afterBytes,
          );
          review.textDiff = lineDiff(liveBytes ?? '', after.afterBytes);
          review.permissionDiff = diffPermissionSurface(
            permissionSurface({ ...described.config, toolset: liveToolset }),
            permissionSurface({ ...described.config, toolset: after.after }),
          );
        }
      }
      review.flags = amendmentFlags({
        record,
        tools: deps.tools,
        livePosture: livePosture(record.personalityId),
        liveToolset,
        afterToolset,
        permissionDiff: review.permissionDiff,
      });
      return review;
    },

    apply(id, opts) {
      return locked(async () => {
        // 2. Status.
        const record = await readAmendment(deps.storage, deps.dataDir, id);
        if (!record) return { ok: false, code: 'not_found', reason: `no amendment ${id}` };
        if (record.status !== 'pending') {
          return { ok: false, code: 'not_pending', reason: `amendment ${id} is ${record.status}` };
        }
        // 3. The personality exists and is user-owned.
        const target = await mutableTarget(record);
        if (!target.ok) return target.result;
        const { registry, described, path } = target;

        // 4. The live bytes are the ones the proposal was filed against.
        const liveBytes = await deps.storage.read(path);
        const liveHash = liveBytes === null ? null : hashDefinitionBytes(liveBytes);
        if (liveBytes === null || liveHash !== record.baseHash) {
          const reason = (await interruptedApply(record, liveHash))
            ? 'an earlier apply wrote toolset.yaml but did not record it; the live file already ' +
              'holds the approved bytes — decline this amendment to close it'
            : 'toolset.yaml changed since this amendment was filed';
          return markStale(record, opts.decidedBy, opts.actor, reason);
        }

        // 5. Recompute; re-validate the ops against the live registry; the constitution.
        const registryProblem = opsRefusal(deps.tools, record.ops);
        if (registryProblem) return markStale(record, opts.decidedBy, opts.actor, registryProblem);
        const after = applyOps(liveBytes, record.ops);
        if (!after.ok) {
          return markStale(record, opts.decidedBy, opts.actor, describeOpsRefusal(after));
        }
        const constitution = await checkConstitution(deps, described.config, after.after);
        if (constitution.kind === 'malformed') {
          return {
            ok: false,
            code: 'constitution_malformed',
            reason: `the constitution is malformed, so nothing was applied (${constitution.error})`,
          };
        }
        if (constitution.kind === 'violation') {
          const next = await transitionAmendment(
            deps.storage,
            deps.dataDir,
            id,
            { to: 'auto_rejected', actor: opts.actor, reason: constitution.reason },
            now,
          );
          deps.observability?.recordSafetyApproval({
            decision: 'denied',
            severity: 'warn',
            code: 'amendment.auto_reject',
            cause: constitution.reason,
            details: { amendmentId: id, personalityId: record.personalityId, ops: record.ops },
          });
          return { ok: false, code: 'auto_rejected', reason: constitution.reason, record: next };
        }

        // 6. The reviewer approved exactly these bytes (G2-5).
        const hash = expectedAfterHash(record.baseHash, opsHash(after.ops), after.afterBytes);
        if (hash !== opts.expectedAfterHash) {
          return {
            ok: false,
            code: 'hash_mismatch',
            reason: 'the change to apply is not the one reviewed; show it again and re-approve',
          };
        }

        // 7. Prior snapshot and marker BEFORE the live write (the promote.ts
        //    order): a crash after this and before the write leaves the record
        //    `pending` over untouched live bytes, and a retry proceeds.
        const afterHash = hashDefinitionBytes(after.afterBytes);
        await deps.storage.writeAtomic(amendmentPriorPath(deps.dataDir, id), liveBytes);
        const marker: AppliedMarker = {
          amendmentId: id,
          personalityId: record.personalityId,
          priorHash: liveHash,
          afterHash,
          at: new Date(now()).toISOString(),
        };
        await deps.storage.writeAtomic(
          amendmentAppliedPath(deps.dataDir, id),
          `${JSON.stringify(marker, null, 2)}\n`,
        );

        // 8. Compare-and-swap onto the bytes the proposal was filed against.
        try {
          await registry.writeDefinitionBytes(
            record.personalityId,
            'toolset.yaml',
            after.afterBytes,
            {
              expectedHash: record.baseHash,
            },
          );
        } catch (err) {
          if (!(err instanceof DefinitionChangedError)) throw err;
          return markStale(
            record,
            opts.decidedBy,
            opts.actor,
            'toolset.yaml changed while applying; nothing was written',
          );
        }

        // 9. Record it.
        const next = await transitionAmendment(
          deps.storage,
          deps.dataDir,
          id,
          { to: 'applied', actor: opts.actor, decidedBy: opts.decidedBy, appliedHash: afterHash },
          now,
        );
        deps.observability?.recordSafetyApproval({
          decision: 'approved',
          severity: 'warn',
          code: 'amendment.approve',
          cause: `applied by ${opts.decidedBy}`,
          details: {
            amendmentId: id,
            personalityId: record.personalityId,
            ops: record.ops,
            baseHash: record.baseHash,
            appliedHash: afterHash,
          },
        });
        return { ok: true, record: next };
      });
    },

    decline(id, opts) {
      return locked(async () => {
        const reason = opts.reason.trim();
        if (!reason) return { ok: false, code: 'reason_required', reason: 'a reason is required' };
        const record = await readAmendment(deps.storage, deps.dataDir, id);
        if (!record) return { ok: false, code: 'not_found', reason: `no amendment ${id}` };
        if (record.status !== 'pending' && record.status !== 'stale') {
          return { ok: false, code: 'not_pending', reason: `amendment ${id} is ${record.status}` };
        }
        const next = await transitionAmendment(
          deps.storage,
          deps.dataDir,
          id,
          { to: 'declined', actor: opts.actor, decidedBy: opts.decidedBy, reason },
          now,
        );
        deps.observability?.recordSafetyApproval({
          decision: 'denied',
          severity: 'info',
          code: 'amendment.decline',
          cause: reason,
          details: { amendmentId: id, personalityId: record.personalityId, ops: record.ops },
        });
        return { ok: true, record: next };
      });
    },

    rollback(id, opts) {
      return locked(async () => {
        const record = await readAmendment(deps.storage, deps.dataDir, id);
        if (!record) return { ok: false, code: 'not_found', reason: `no amendment ${id}` };
        const appliedHash = record.applied?.appliedHash;
        if (record.status !== 'applied' || !appliedHash) {
          return { ok: false, code: 'not_applied', reason: `amendment ${id} is ${record.status}` };
        }
        const target = await mutableTarget(record);
        if (!target.ok) return target.result;
        const { registry, described, path } = target;

        // Only onto the exact bytes this apply wrote — so stacked applies unwind LIFO.
        const live = await deps.storage.read(path);
        if (live === null || hashDefinitionBytes(live) !== appliedHash) {
          return {
            ok: false,
            code: 'live_edited',
            reason:
              'toolset.yaml changed since this amendment was applied (a later amendment or an ' +
              'edit); roll that back first',
          };
        }
        // The snapshot lives in the amendment's own directory (by id); its
        // hash must be the base the proposal was filed against.
        const prior = await deps.storage.read(amendmentPriorPath(deps.dataDir, id));
        if (prior === null || hashDefinitionBytes(prior) !== record.baseHash) {
          return {
            ok: false,
            code: 'prior_missing',
            reason: `the prior toolset.yaml snapshot for ${id} is missing or does not match`,
          };
        }
        const constitution = await checkConstitution(
          deps,
          described.config,
          parseToolsetYaml(prior),
        );
        if (constitution.kind === 'malformed') {
          return {
            ok: false,
            code: 'constitution_malformed',
            reason: `the constitution is malformed, so nothing was rolled back (${constitution.error})`,
          };
        }
        if (constitution.kind === 'violation') {
          return {
            ok: false,
            code: 'constitution_violation',
            reason: `the constitution forbids the prior toolset: ${constitution.reason}`,
          };
        }
        try {
          await registry.writeDefinitionBytes(record.personalityId, 'toolset.yaml', prior, {
            expectedHash: appliedHash,
          });
        } catch (err) {
          if (!(err instanceof DefinitionChangedError)) throw err;
          return {
            ok: false,
            code: 'live_edited',
            reason: 'toolset.yaml changed while rolling back; nothing was written',
          };
        }
        const next = await transitionAmendment(
          deps.storage,
          deps.dataDir,
          id,
          { to: 'rolled_back', actor: opts.actor, decidedBy: opts.decidedBy },
          now,
        );
        deps.observability?.recordSafetyApproval({
          decision: 'approved',
          severity: 'warn',
          code: 'amendment.rollback',
          cause: `rolled back by ${opts.decidedBy}`,
          details: {
            amendmentId: id,
            personalityId: record.personalityId,
            ops: record.ops,
            restoredHash: record.baseHash,
          },
        });
        return { ok: true, record: next };
      });
    },
  };
}
