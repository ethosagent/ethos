// Governed self-amendment — the FILING intake (plan
// personality-memory-boundary-and-self-amendment, G2, "The intake").
//
// `createAmendmentIntake` implements the `AmendmentSubmitPort` the
// `propose_self_amendment` tool holds (extensions/tools-personality-design/src/
// propose-amendment.ts). It only files: it writes a `pending` (or
// `auto_rejected`) record into the amendment store (`@ethosagent/learning-inbox`
// `createAmendment`) and never touches the personality's `toolset.yaml`. Apply,
// decline and rollback are `AmendmentService` (plan step 11), reachable only
// from the TTY-gated CLI (G2-1).
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
  type AmendmentOpsRefusal,
  amendmentApplyLockPath,
  applyOps,
  checkPendingLimits,
  createAmendment,
  opsHash,
} from '@ethosagent/learning-inbox';
import { hashDefinitionBytes } from '@ethosagent/personalities';
import { redactString } from '@ethosagent/safety-redact';
import { PROPOSE_SELF_AMENDMENT_TOOL } from '@ethosagent/tools-personality-design';
import {
  type AmendmentEvidence,
  type AmendmentOp,
  type AmendmentPreCheck,
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
 * cannot both pass the 3-pending limit; apply, decline and rollback (plan step
 * 11) take the same lock. A contended filing waits `LOCK_WAIT_MS`, then refuses
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
      `${timeoutMs}ms, so nothing was filed. ` +
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
