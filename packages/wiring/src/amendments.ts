// Governed self-amendment (plan personality-memory-boundary-and-self-amendment,
// G2): the FILING intake ("The intake") and the owner's review service
// ("Apply, decline, rollback", `createAmendmentService`, below the intake).
//
// `createAmendmentIntake` implements the `AmendmentSubmitPort` the
// `propose_self_amendment` tool holds (extensions/tools-personality-design/src/
// propose-amendment.ts). It only files: it writes a `pending` (or
// `auto_rejected`) record into the amendment store (`@ethosagent/learning-inbox`
// `createAmendment`) and never touches the personality's definition. Two
// targets share every step (`AMENDMENT_TARGET_FILES`): `toolset` changes
// `toolset.yaml`; `identity` (plan personality-presence-and-initiative §1, the
// birth ritual) changes the name, description, `display.emoji` and avatar lines
// of `config.yaml` (`applyTargetOps`). Applying an identity amendment clears the
// personality's birth marker (`clearBirthMarker`, @ethosagent/personalities).
// Identity filings are NOT limited to a birth: a personality holding the tool
// may propose a new name or vibe at any time, under the same checks as a
// toolset change. That is deliberate and no wider than the toolset target,
// which grants tools: the intake only ever writes a `pending` record
// (`createAmendment` below, never `writeDefinitionBytes`), the lines it can
// touch are the four in `identityUpdates` (never `display.avatar_url`), and
// the only writer is `AmendmentService.apply`, whose only applying caller is
// the TTY-gated CLI (`assertTty`, apps/ethos/src/commands/
// personality-amendments.ts). Pinned by 'files an identity amendment outside a
// birth too' in __tests__/birth-ritual.test.ts. Apply,
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
//                              (for both targets)
//   4. target (D25)          — not a built-in
//   5. ops                   — `opsRefusal` (toolset), then `applyTargetOps`
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
  canonicalizeAmendmentOps,
  canonicalizeIdentityOps,
  checkPendingLimits,
  createAmendment,
  describeIdentityOpsRefusal,
  expectedAfterHash,
  listAmendments,
  opsHash,
  readAmendment,
  transitionAmendment,
} from '@ethosagent/learning-inbox';
import {
  clearBirthMarker,
  createPersonalityRegistry,
  DefinitionChangedError,
  type DescribedPersonality,
  diffPermissionSurface,
  type FilePersonalityRegistry,
  hashDefinitionBytes,
  notComparedLine,
  type PermissionDiff,
  permissionSurface,
  setConfigYamlScalars,
} from '@ethosagent/personalities';
import { redactString } from '@ethosagent/safety-redact';
import { PROPOSE_SELF_AMENDMENT_TOOL } from '@ethosagent/tools-personality-design';
import {
  AMENDMENT_TARGET_FILES,
  type AmendmentActor,
  type AmendmentEvidence,
  type AmendmentFlag,
  type AmendmentOp,
  type AmendmentPreCheck,
  type AmendmentRecord,
  type AmendmentSubmitInput,
  type AmendmentSubmitPort,
  type AmendmentSubmitResult,
  type AmendmentTarget,
  type ExecutionPosture,
  type IdentityAmendmentOp,
  isToolsetAmendmentOp,
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
/** Longest tool name an evidence row keeps (`evidenceToolName`). */
const EVIDENCE_TOOL_NAME_CHARS = 128;

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
 * cannot both pass the 3-pending limit; apply, decline, rollback and
 * refresh (`createAmendmentService`, through its `locked` wrapper) take the
 * same lock, so no two of the five interleave. A contended filing waits
 * `LOCK_WAIT_MS`, then refuses with nothing written.
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
 * What {@link gateRefusal} reads. A `ToolContext` satisfies it, and so does a
 * `PromptContext` (the fields `assembleContext` copies from `RunOptions`,
 * packages/core/src/agent-loop/stages/context-assembly.ts) — so the birth-ritual
 * injector (`createBirthRitualInjector`, ./birth-ritual.ts) applies the SAME
 * gate the filing does, before the model is ever told about the ritual.
 */
export type AmendmentGateContext = Pick<
  ToolContext,
  | 'personalityId'
  | 'initiator'
  | 'roomAudience'
  | 'sessionKey'
  | 'jobId'
  | 'reviewOfJobId'
  | 'agentId'
  | 'dryRun'
>;

/**
 * Check 1 (D23): a person started this turn, in a private room, on the owner's
 * CLI or cookie-authenticated web app, as a top-level foreground turn.
 *
 * `initiator === 'user'` is set only by attended surfaces: the CLI REPL
 * (apps/ethos/src/commands/chat.ts), the TUI (apps/tui/src/components/App.tsx),
 * web chat for a POSITIVE cookie session (apps/web-api/src/features/chat/rpc/
 * send.ts — a bearer key or an unrecorded auth method gets `'system'`) and the
 * gateway for a real inbound message.
 * The key-prefix check is the second lock: it drops gateway DMs (owner DMs are
 * v1.1) and `acp:`, which mesh peers open.
 */
export function gateRefusal(ctx: AmendmentGateContext): string | null {
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
 * Check 2: nothing untrusted is in the context the model saw. The scan reads
 * every stored message rather than the loop's `historyLimit` tail, so it can
 * only refuse more, never less. Its window:
 * - with no compaction watermark, the whole stored history;
 * - with a DROP-ONLY watermark (no `summaryText`), the stored messages from the
 *   watermark on — the same `reconstructFromWatermark` the loop's context
 *   assembly uses; what it dropped never reaches the model again;
 * - with a SUMMARY watermark, the whole stored history again: the summary was
 *   written from the dropped rows and is re-injected as a synthetic message
 *   (`reconstructFromWatermark`, packages/core/src/agent-loop/manual-compact.ts),
 *   so untrusted text summarised out of the window is still in the context.
 * Tainted by:
 * - an attachment on this turn or on any user message in the window;
 * - a result from a tool whose `outputIsUntrusted` is set — looked up by name,
 *   because stored rows do not record the flag;
 * - any `mcp__*` result, any result from a tool no longer registered, and any
 *   result with no tool name;
 * - any result from a recall tool (`RECALL_TOOLS`: `session_search`,
 *   `get_session_events`, `get_observability`): it returns stored messages or
 *   telemetry, this session's pre-watermark rows included, so it can carry
 *   anything above.
 * NOT seen (a documented limitation, verification round F6): text the prompt
 * assembles from files, which is never a stored message — project context
 * (`AGENTS.md`, `CLAUDE.md` in the working directory), skills from the
 * project, home and state dirs, and memory; and third-party text a trusted
 * tool re-serves from its own store (team memory, kanban comments, cron run
 * output, goal output, pending skills, session titles), whose result is
 * judged by that tool's own trust. A turn that can write one of those can
 * steer a later filing; see the G2 limitations in
 * docs/content/security/security-boundary.md.
 * A failed result is judged exactly like a successful one — a failing
 * `terminal` still printed what `curl` fetched, and an MCP server's error text
 * is its own. The only rows skipped are the framework's own refusals
 * (`isFrameworkRefusal`), which carry no tool output and are the evidence
 * check 6 accepts.
 *
 * The birth-ritual injector (`createBirthRitualInjector`, ./birth-ritual.ts)
 * calls this same function with the turn's `PromptContext`, which carries no
 * attachments list: the turn's own message is already stored by then, with
 * its `<attachments>` annotation or content blocks (`assembleContext`,
 * packages/core/src/agent-loop/stages/context-assembly.ts), so the history
 * scan sees it.
 */
export async function taintRefusal(
  deps: Pick<AmendmentIntakeDeps, 'sessions' | 'tools'>,
  ctx: Pick<ToolContext, 'sessionId' | 'attachments'>,
): Promise<string | null> {
  if ((ctx.attachments?.list().length ?? 0) > 0) return AMENDMENT_TAINT_REFUSAL;
  const history = (await deps.sessions.getMessages(ctx.sessionId)).filter(
    (m) => m.role !== 'system',
  );
  const watermark = selectActiveWatermark(await deps.sessions.listCompressions(ctx.sessionId));
  const window =
    watermark && !watermark.summaryText
      ? reconstructFromWatermark(history, watermark).history
      : history;
  for (const message of window) {
    if (isTainted(deps.tools, message)) return AMENDMENT_TAINT_REFUSAL;
  }
  return null;
}

/**
 * The refusals the framework itself writes for a call that never ran, by the
 * tool name the row records: the registry's unknown-tool, surface, toolset and
 * availability refusals (`DefaultToolRegistry.executeParallel`,
 * packages/core/src/tool-registry.ts) and the approval hook's toolset refusal
 * (`notPermittedRefusal`, packages/wiring/src/approval-seams.ts). Pinned
 * against both producers by the 'framework refusal texts' case in
 * packages/wiring/src/__tests__/propose-amendment.test.ts, so a reworded
 * refusal fails a test instead of silently tainting.
 */
function frameworkRefusalTexts(tool: string): readonly string[] {
  return [
    `Unknown tool: ${tool}`,
    `Tool ${tool} is not available on this surface`,
    `Tool ${tool} is not permitted for this personality`,
    `Tool ${tool} is not currently available`,
  ];
}

/**
 * A stored row is a framework refusal only when it is recorded as an error AND
 * its content is EXACTLY one of {@link frameworkRefusalTexts} for its own tool
 * name. Exact, not a prefix: a tool's own error that merely starts with the
 * same words is judged as tool output. A registry refusal of an
 * `outputIsUntrusted` tool (an MCP tool included) is stored inside the
 * untrusted wrap (packages/core/src/agent-loop/stages/tool-processing.ts), so
 * it does not match and taints — the fail-safe side; it still counts as
 * evidence, which reads only `isError`.
 */
export function isFrameworkRefusal(message: StoredMessage): boolean {
  if (message.role !== 'tool_result' || message.isError !== true || !message.toolName) {
    return false;
  }
  return frameworkRefusalTexts(message.toolName).includes(message.content);
}

/**
 * Tools whose output is stored conversation or telemetry text, and so can
 * carry anything that was ever in it: `session_search` (snippets of stored
 * messages), and the debug tools `get_session_events` (another session's
 * messages) and `get_observability` (span and event payloads, tool arguments
 * included) — verification round F5.
 */
const RECALL_TOOLS: ReadonlySet<string> = new Set([
  'session_search',
  'get_session_events',
  'get_observability',
]);

function isTainted(tools: Pick<ToolRegistry, 'get'>, message: StoredMessage): boolean {
  if (message.role === 'user' || message.role === 'user_steer') {
    return (message.contentBlocks?.length ?? 0) > 0 || message.content.includes('<attachments>');
  }
  if (message.role !== 'tool_result' || isFrameworkRefusal(message)) return false;
  const name = message.toolName;
  if (!name || name.startsWith('mcp__') || RECALL_TOOLS.has(name)) return true;
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
  for (const op of ops) {
    if (!isToolsetAmendmentOp(op)) continue;
    const { tool } = op;
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
      toolName: evidenceToolName(row.toolName),
      messageId: row.id,
      excerpt: redactString(row.content).slice(0, EVIDENCE_EXCERPT_CHARS),
    });
  }
  return evidence;
}

/**
 * The tool name an evidence row records. A refused call's name is whatever the
 * model asked for — the registry's `Unknown tool: <name>` refusal is stored
 * under it — so anything outside a tool name's charset is replaced and the
 * length capped before it reaches the record (verification round F4; the CLI
 * also cleans every printed string, `clean` in
 * apps/ethos/src/commands/personality-amendments.ts).
 */
function evidenceToolName(name: string | undefined): string {
  if (!name) return 'unknown';
  return name.replace(/[^A-Za-z0-9_.:-]/g, '?').slice(0, EVIDENCE_TOOL_NAME_CHARS);
}

/** A shell or code runner — the tools that make a `local` posture able to edit its own files. */
function isShellTool(tool: string): boolean {
  return tool === 'terminal' || tool === 'run_code' || tool.startsWith('process_');
}

/** Where `writeDefinitionBytes` writes: the directory of the personality's SOUL.md. */
function definitionPathOf(
  config: PersonalityConfig,
  file: 'toolset.yaml' | 'config.yaml' = 'toolset.yaml',
): string | null {
  return config.soulFile ? join(dirname(config.soulFile), file) : null;
}

/**
 * The `config.yaml` keys each identity op sets. The avatar op sets none:
 * `display.avatar_url` and the bytes behind it are written by
 * `FilePersonalityRegistry.writeAvatar` and removed by `deleteAvatar` (the web
 * avatar routes, apps/web-api/src/routes/personality-avatar.ts), never by an
 * amendment — removing the line here would orphan the stored image.
 * - `generated` keeps the generated mark, so it is refused while an avatar is
 *   set (`avatarRefusal`), never applied by deleting it;
 * - `upload` is the owner's to do after applying.
 */
function identityUpdates(ops: readonly IdentityAmendmentOp[]): Record<string, string | null> {
  const updates: Record<string, string | null> = {};
  for (const op of ops) {
    if (op.op === 'set_name') updates.name = op.value;
    else if (op.op === 'set_description') updates.description = op.value;
    else if (op.op === 'set_display_emoji') updates['display.emoji'] = op.value;
  }
  return updates;
}

/** A non-empty `display.avatar_url` line (quotes stripped, as the loader reads it). */
function hasAvatarUrl(configBytes: string): boolean {
  const value = /^display\.avatar_url:[ \t]*(.*)$/m.exec(configBytes)?.[1]?.trim() ?? '';
  return value.replace(/^(["'])(.*)\1$/, '$2').length > 0;
}

/**
 * `set_display_avatar: generated` over a personality that already has an
 * avatar: the operator chose that image (the web create forms may attach one),
 * so the ritual keeps it by leaving the avatar op out; removing it is the
 * owner's, from the web Personalities page. Pinned by 'birth ritual — the
 * avatar step (M3)' in __tests__/birth-ritual.test.ts.
 */
function avatarRefusal(ops: readonly IdentityAmendmentOp[], liveBytes: string): string | null {
  const generated = ops.some((o) => o.op === 'set_display_avatar' && o.value === 'generated');
  return generated && hasAvatarUrl(liveBytes)
    ? "this personality already has an avatar; leave set_display_avatar out to keep it (the owner removes it from the web Personalities page), or use 'upload' to replace it"
    : null;
}

/**
 * The target's after-bytes from its live bytes, or the refusal as text. The
 * ONE function filing, review, apply, crash recovery and rollback use, so all
 * of them compute the same bytes and `expectedAfterHash` from the same inputs.
 * - `toolset` — `applyOps` (@ethosagent/learning-inbox).
 * - `identity` — `canonicalizeIdentityOps` (the values, the emoji through
 *   `isSingleEmojiGrapheme`), `avatarRefusal`, then `setConfigYamlScalars`
 *   (@ethosagent/personalities), which leaves every other line of
 *   `config.yaml` byte for byte. Unlike a toolset `no_op`, a request that
 *   changes no line is accepted: it CONFIRMS the identity as it is — the
 *   name the operator typed at create time, or an upload-only request — and
 *   applying it ends a birth ritual like any other identity change
 *   (`clearBirthOnIdentity`). Pinned by 'accepts confirming the identity
 *   as-is' in __tests__/birth-ritual.test.ts.
 */
function applyTargetOps(
  target: AmendmentTarget,
  liveBytes: string | null,
  ops: readonly AmendmentOp[],
):
  | { ok: true; ops: AmendmentOp[]; afterBytes: string; toolset?: string[] }
  | { ok: false; reason: string } {
  if (target === 'toolset') {
    const applied = applyOps(liveBytes, ops);
    if (!applied.ok) return { ok: false, reason: describeOpsRefusal(applied) };
    return { ok: true, ops: applied.ops, afterBytes: applied.afterBytes, toolset: applied.after };
  }
  const canonical = canonicalizeIdentityOps(ops);
  if (!canonical.ok) return { ok: false, reason: describeIdentityOpsRefusal(canonical) };
  if (!liveBytes) return { ok: false, reason: 'config.yaml is missing' };
  const avatar = avatarRefusal(canonical.ops, liveBytes);
  if (avatar) return { ok: false, reason: avatar };
  const afterBytes = setConfigYamlScalars(liveBytes, identityUpdates(canonical.ops));
  return { ok: true, ops: canonical.ops, afterBytes };
}

/**
 * The personality the constitution judges after a change. For `identity`, the
 * name, description and display lines are set; `enforceConstitution`
 * (extensions/constitution/src/index.ts) reads the toolset, network allow
 * list, budget and mounts, none of which an identity op touches, so an
 * identity change can never be the cause of a violation — the check still
 * runs, over the same path, so a live violation refuses exactly as it does for
 * a toolset change.
 */
function configAfter(
  config: PersonalityConfig,
  target: AmendmentTarget,
  applied: { ops: readonly AmendmentOp[]; toolset?: string[] },
): PersonalityConfig {
  if (target === 'toolset') return { ...config, toolset: applied.toolset ?? config.toolset };
  const next: PersonalityConfig = { ...config };
  for (const op of applied.ops) {
    if (isToolsetAmendmentOp(op)) continue;
    if (op.op === 'set_name') next.name = op.value;
    else if (op.op === 'set_description') next.description = op.value;
    else if (op.op === 'set_display_emoji') next.display = { ...next.display, emoji: op.value };
  }
  return next;
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
export function isUserOwned(config: PersonalityConfig, dataDir: string): boolean {
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
      //    The same opt-in for both targets.
      const target: AmendmentTarget = input.target ?? 'toolset';
      const config = deps.personalities.get(personalityId);
      const toolsetPath = config ? definitionPathOf(config) : null;
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

      // 5. Ops, against the target's live file (`toolset.yaml` was read above).
      const targetPath = join(dirname(toolsetPath), AMENDMENT_TARGET_FILES[target]);
      const targetBytes = target === 'toolset' ? liveBytes : await deps.storage.read(targetPath);
      if (target === 'toolset') {
        const registryRefusal = opsRefusal(deps.tools, input.ops);
        if (registryRefusal) return refuse(registryRefusal);
      }
      const applied = applyTargetOps(target, targetBytes, input.ops);
      if (!applied.ok) return refuse(applied.reason);

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
        const lockedBytes = await deps.storage.read(targetPath);
        if (lockedBytes !== targetBytes) {
          return refuse(`${AMENDMENT_TARGET_FILES[target]} changed while filing; try again`);
        }

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
          const after = configAfter(structuredClone(config), target, applied);
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
            target,
            ops: applied.ops,
            baseHash: hashDefinitionBytes(targetBytes ?? ''),
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
// The review service: list, get, apply, decline, rollback, refresh (plan G2,
// "Apply, decline, rollback"). No filing path: it cannot create a record, and
// the `propose_self_amendment` tool is never handed it (compose-tools.ts passes
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
  /** The definition file the record's target writes (`AMENDMENT_TARGET_FILES`). */
  file: 'toolset.yaml' | 'config.yaml';
  /** The personality still loads and is user-owned (the only kind apply writes). */
  personality: 'ok' | 'not_found' | 'builtin';
  /** The live bytes of {@link file}; `null` when the file (or the personality) is gone. */
  liveBytes: string | null;
  liveHash: string | null;
  /** The live file is not the bytes the proposal was filed against — apply would go `stale`. */
  stale: boolean;
  /**
   * A `pending` or `stale` record whose earlier apply wrote `applied.json` and
   * the live file, and died before recording it: the live bytes are exactly
   * the marker's `afterHash`, which is the ops applied to the prior snapshot.
   * The next `apply` or `refresh` completes it to `applied`
   * (`recoverInterruptedApply`), so it can be rolled back.
   */
  interruptedApply: boolean;
  /** `applyTargetOps` on the LIVE bytes; `null` when the ops no longer apply (`opsProblem`). */
  afterBytes: string | null;
  opsProblem?: string;
  /**
   * `sha256(baseHash ‖ opsHash ‖ afterBytes)` over the live after-bytes — the
   * value apply must be handed (G2-5). `null` when there is nothing to apply.
   */
  expectedAfterHash: string | null;
  /** Line diff of {@link file}, live → after: each line prefixed `' '`, `'-'` or `'+'`. */
  textDiff: string[];
  /**
   * For an `applied` record: the line diff a rollback would make, live → the
   * prior snapshot. Empty when there is nothing to roll back or no snapshot.
   */
  rollbackDiff: string[];
  /** The toolset target's permission diff; `null` for an identity change, which grants nothing. */
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
  | 'record_mismatch'
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
  /**
   * Bring a `pending` or `stale` record in line with live state, under the
   * lock: an interrupted apply is completed to `applied`
   * (`recoverInterruptedApply`); a `pending` record whose live `toolset.yaml`
   * no longer hashes to `baseHash`, or whose ops no longer apply, becomes
   * `stale` (answered `ok: false`, code `stale`) and stops counting toward the
   * pending limit (`checkPendingLimits` counts `pending` only). Anything else
   * is returned unchanged. Writes no definition bytes.
   */
  refresh(
    id: string,
    opts: { actor: AmendmentActor; decidedBy: string },
  ): Promise<AmendmentActionResult>;
}

/**
 * Body of `applied.json`, written before the live write (the `promote.ts`
 * order). `actor`/`decidedBy` are the approving decision, so crash recovery
 * records the person who approved, not whoever ran the recovery; absent on a
 * marker written before they were recorded.
 */
interface AppliedMarker {
  amendmentId: string;
  personalityId: string;
  priorHash: string;
  afterHash: string;
  at: string;
  actor?: AmendmentActor;
  decidedBy?: string;
}

const ACTORS: ReadonlySet<string> = new Set<AmendmentActor>(['intake', 'cli', 'web']);

/** `applied.json` for `amendmentId`, or null when it is missing, unparseable or another record's. */
function parseAppliedMarker(raw: string, amendmentId: string): AppliedMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const m = parsed as Record<string, unknown>;
  if (
    m.amendmentId !== amendmentId ||
    typeof m.personalityId !== 'string' ||
    typeof m.priorHash !== 'string' ||
    typeof m.afterHash !== 'string' ||
    typeof m.at !== 'string'
  ) {
    return null;
  }
  return {
    amendmentId,
    personalityId: m.personalityId,
    priorHash: m.priorHash,
    afterHash: m.afterHash,
    at: m.at,
    ...(typeof m.actor === 'string' && ACTORS.has(m.actor)
      ? { actor: m.actor as AmendmentActor }
      : {}),
    ...(typeof m.decidedBy === 'string' && m.decidedBy ? { decidedBy: m.decidedBy } : {}),
  };
}

/** The definition file a record's target writes. */
function fileOf(record: Pick<AmendmentRecord, 'target'>): 'toolset.yaml' | 'config.yaml' {
  return AMENDMENT_TARGET_FILES[record.target];
}

type ConstitutionOutcome =
  | { kind: 'ok' }
  | { kind: 'violation'; reason: string }
  | { kind: 'malformed'; error: string };

/**
 * The constitution over a CLONE of `config` — `enforceConstitution` clamps
 * `budgetCapUsd` in place, and the registry hands out live references (G2-3).
 * Callers pass the after-state (`configAfter`).
 */
async function checkConstitution(
  deps: Pick<AmendmentServiceDeps, 'storage' | 'dataDir' | 'workingDir' | 'log'>,
  config: PersonalityConfig,
): Promise<ConstitutionOutcome> {
  const constitution = await loadConstitution(deps.storage, deps.dataDir);
  if (constitution.status === 'malformed') return { kind: 'malformed', error: constitution.error };
  try {
    enforceConstitution({
      constitution: constitution.constitution,
      personalities: [structuredClone(config)],
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

/** Longest-common-subsequence line diff; `toolset.yaml` and `config.yaml` are short, so O(n·m) is fine. */
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
  for (const op of record.ops) {
    if (op.op === 'add_tool' && tools.get(op.tool)?.isAvailable?.() === false) {
      flags.add('tool-unavailable');
    }
  }
  // Evidence is a refused tool call — it is what a TOOLSET request cites. An
  // identity request has none to cite, so its absence flags nothing.
  if (record.target === 'toolset' && record.evidence.length === 0) {
    flags.add('no-recorded-refusal');
  }
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
function livePath(
  described: DescribedPersonality,
  record: Pick<AmendmentRecord, 'target'>,
): string | null {
  return definitionPathOf(described.config, fileOf(record));
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
    const path = described ? livePath(described, record) : null;
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

  /**
   * The `applied.json` of an earlier apply of `record` that wrote the live file
   * but never recorded it, or null. Proof, not a hint: the marker names this
   * record, the prior snapshot hashes to `baseHash`, the record's ops turn that
   * snapshot into the marker's `afterHash`, and the live file hashes to it.
   * And the live bytes are THIS record's (verification round F9): no other
   * amendment of the same personality and target was applied after the marker
   * was written, or is applied with the live hash — otherwise a later
   * amendment that produced identical bytes (the owner re-filed and applied
   * the same change) would be recorded twice, and rolling back either would
   * disown the other. Such a record is left as it is.
   */
  async function interruptedMarker(
    record: AmendmentRecord,
    liveHash: string | null,
  ): Promise<AppliedMarker | null> {
    if (liveHash === null) return null;
    const raw = await deps.storage.read(amendmentAppliedPath(deps.dataDir, record.id));
    const prior = await deps.storage.read(
      amendmentPriorPath(deps.dataDir, record.id, fileOf(record)),
    );
    if (raw === null || prior === null) return null;
    const marker = parseAppliedMarker(raw, record.id);
    if (!marker || marker.afterHash !== liveHash) return null;
    if (hashDefinitionBytes(prior) !== record.baseHash) return null;
    const after = applyTargetOps(record.target, prior, record.ops);
    if (!after.ok || hashDefinitionBytes(after.afterBytes) !== liveHash) return null;
    const siblings = await listAmendments(deps.storage, deps.dataDir, {
      personalityId: record.personalityId,
    });
    const claimed = siblings.some(
      (other) =>
        other.id !== record.id &&
        other.target === record.target &&
        other.applied !== undefined &&
        ((other.status === 'applied' && other.applied.appliedHash === liveHash) ||
          other.applied.at > marker.at),
    );
    return claimed ? null : marker;
  }

  /**
   * Complete an apply that wrote the live bytes and died before recording it
   * (C4): `pending`/`stale` → `applied` with the marker's `afterHash`, and the
   * `amendment.approve` row the crash skipped. The approver is the one the
   * marker recorded; a marker from before that was recorded falls back to the
   * caller. Nothing is written to the definition — the bytes are already live.
   */
  async function recoverInterruptedApply(
    record: AmendmentRecord,
    marker: AppliedMarker,
    caller: { actor: AmendmentActor; decidedBy: string },
  ): Promise<AmendmentActionResult> {
    const decidedBy = marker.decidedBy ?? caller.decidedBy;
    const next = await transitionAmendment(
      deps.storage,
      deps.dataDir,
      record.id,
      {
        to: 'applied',
        actor: marker.actor ?? caller.actor,
        decidedBy,
        reason: 'recovered: an interrupted apply had already written the approved bytes',
        appliedHash: marker.afterHash,
      },
      now,
    );
    deps.observability?.recordSafetyApproval({
      decision: 'approved',
      severity: 'warn',
      code: 'amendment.approve',
      cause: `applied by ${decidedBy} (recovered after an interrupted apply)`,
      details: {
        amendmentId: record.id,
        personalityId: record.personalityId,
        ops: record.ops,
        baseHash: record.baseHash,
        appliedHash: marker.afterHash,
        recovered: true,
      },
    });
    await clearBirthOnIdentity(record);
    return { ok: true, record: next };
  }

  /**
   * An applied identity amendment ends the personality's birth ritual
   * (plan personality-presence-and-initiative §1): its marker is removed.
   * Housekeeping, not the guarantee — it runs AFTER the record is `applied`,
   * and `createBirthRitualInjector` (./birth-ritual.ts) is silent for any
   * personality with an `applied` identity amendment whether or not the
   * marker is gone. So a failure here is logged and swallowed: the apply
   * succeeded, and reporting it as failed would invite a second one. Pinned by
   * 'reports a successful apply as applied when clearing the marker throws'
   * and 'stays silent once an identity amendment is applied, even if the
   * marker survived' in __tests__/birth-ritual.test.ts.
   */
  async function clearBirthOnIdentity(record: AmendmentRecord): Promise<void> {
    if (record.target !== 'identity') return;
    try {
      await clearBirthMarker(deps.storage, deps.dataDir, record.personalityId);
    } catch (err) {
      deps.log.warn('amendment applied, but its birth marker could not be removed', {
        amendmentId: record.id,
        personalityId: record.personalityId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Why a `pending` record no longer applies to the live bytes, or null when it still does. */
  function staleReason(
    record: AmendmentRecord,
    liveBytes: string | null,
    liveHash: string | null,
  ): string | null {
    if (liveBytes === null || liveHash !== record.baseHash) {
      return `${fileOf(record)} changed since this amendment was filed`;
    }
    const registryProblem = opsRefusal(deps.tools, record.ops);
    if (registryProblem) return registryProblem;
    const after = applyTargetOps(record.target, liveBytes, record.ops);
    return after.ok ? null : after.reason;
  }

  async function readOrNull(path: string | null): Promise<string | null> {
    return path ? deps.storage.read(path) : null;
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
      const path = described ? livePath(described, record) : null;
      const liveBytes = path ? await deps.storage.read(path) : null;
      const liveHash = liveBytes === null ? null : hashDefinitionBytes(liveBytes);
      const open = record.status === 'pending' || record.status === 'stale';
      const review: AmendmentReview = {
        record,
        file: fileOf(record),
        personality: !described || !path ? 'not_found' : described.builtin ? 'builtin' : 'ok',
        liveBytes,
        liveHash,
        stale: liveHash !== record.baseHash,
        interruptedApply: open && (await interruptedMarker(record, liveHash)) !== null,
        afterBytes: null,
        expectedAfterHash: null,
        textDiff: [],
        rollbackDiff: [],
        permissionDiff: null,
        notCompared: notComparedLine(),
        flags: [],
      };
      // The toolset the flags judge: the target's own bytes for a toolset
      // request, the live `toolset.yaml` (unchanged by it) for an identity one.
      const toolsetBytes =
        record.target === 'toolset'
          ? liveBytes
          : described
            ? await readOrNull(definitionPathOf(described.config))
            : null;
      const liveToolset = toolsetBytes === null ? [] : parseToolsetYaml(toolsetBytes);
      let afterToolset: string[] = liveToolset;
      if (described && open) {
        const registryProblem = opsRefusal(deps.tools, record.ops);
        const after = applyTargetOps(record.target, liveBytes, record.ops);
        if (registryProblem) review.opsProblem = registryProblem;
        else if (!after.ok) review.opsProblem = after.reason;
        if (after.ok && !registryProblem) {
          afterToolset = after.toolset ?? liveToolset;
          review.afterBytes = after.afterBytes;
          review.expectedAfterHash = expectedAfterHash(
            record.baseHash,
            opsHash(after.ops),
            after.afterBytes,
          );
          review.textDiff = lineDiff(liveBytes ?? '', after.afterBytes);
          if (after.toolset) {
            review.permissionDiff = diffPermissionSurface(
              permissionSurface({ ...described.config, toolset: liveToolset }),
              permissionSurface({ ...described.config, toolset: after.toolset }),
            );
          }
        }
      }
      if (record.status === 'applied' && liveBytes !== null) {
        const prior = await deps.storage.read(
          amendmentPriorPath(deps.dataDir, record.id, fileOf(record)),
        );
        if (prior !== null) review.rollbackDiff = lineDiff(liveBytes, prior);
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
        if (record.status !== 'pending' && record.status !== 'stale') {
          return { ok: false, code: 'not_pending', reason: `amendment ${id} is ${record.status}` };
        }
        // 3. The personality exists and is user-owned.
        const target = await mutableTarget(record);
        if (!target.ok) return target.result;
        const { registry, described, path } = target;
        const liveBytes = await deps.storage.read(path);
        const liveHash = liveBytes === null ? null : hashDefinitionBytes(liveBytes);

        // An earlier apply already wrote the approved bytes: record it (C4).
        // No reviewer hash is needed — no new bytes are written.
        const marker = await interruptedMarker(record, liveHash);
        if (marker) return recoverInterruptedApply(record, marker, opts);
        if (record.status !== 'pending') {
          return { ok: false, code: 'not_pending', reason: `amendment ${id} is ${record.status}` };
        }

        // 4. The reviewer approved exactly these bytes (G2-5) — checked before
        //    anything is recorded, so a mismatched hash changes no status.
        const after = applyTargetOps(record.target, liveBytes, record.ops);
        if (
          !after.ok ||
          expectedAfterHash(record.baseHash, opsHash(after.ops), after.afterBytes) !==
            opts.expectedAfterHash
        ) {
          return {
            ok: false,
            code: 'hash_mismatch',
            reason: 'the change to apply is not the one reviewed; show it again and re-approve',
          };
        }

        // 5. The live bytes are the ones the proposal was filed against, and
        //    the ops still name registered, toolset-gated tools.
        const stale = staleReason(record, liveBytes, liveHash);
        if (stale || liveBytes === null || liveHash === null) {
          return markStale(
            record,
            opts.decidedBy,
            opts.actor,
            stale ?? `${fileOf(record)} is missing`,
          );
        }

        // 6. The constitution. A violation the LIVE definition already has is
        //    not this change's doing — often a `${CWD}` rule read from the
        //    reviewer's working directory — so it refuses and records nothing;
        //    only a violation the delta introduces auto-rejects.
        const constitution = await checkConstitution(
          deps,
          configAfter(described.config, record.target, after),
        );
        if (constitution.kind === 'malformed') {
          return {
            ok: false,
            code: 'constitution_malformed',
            reason: `the constitution is malformed, so nothing was applied (${constitution.error})`,
          };
        }
        if (constitution.kind === 'violation') {
          const live = await checkConstitution(
            deps,
            record.target === 'toolset'
              ? { ...described.config, toolset: parseToolsetYaml(liveBytes) }
              : described.config,
          );
          if (live.kind !== 'ok') {
            return {
              ok: false,
              code: 'constitution_violation',
              reason:
                `the constitution already forbids ${record.personalityId}'s current definition, ` +
                `so this change is not the cause; nothing was recorded (${constitution.reason})`,
            };
          }
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

        // 7. Prior snapshot and marker BEFORE the live write (the promote.ts
        //    order): a crash after this and before the write leaves the record
        //    `pending` over untouched live bytes, and a retry proceeds; a crash
        //    after the write is completed by the next apply or refresh.
        const afterHash = hashDefinitionBytes(after.afterBytes);
        await deps.storage.writeAtomic(
          amendmentPriorPath(deps.dataDir, id, fileOf(record)),
          liveBytes,
        );
        const appliedMarker: AppliedMarker = {
          amendmentId: id,
          personalityId: record.personalityId,
          priorHash: liveHash,
          afterHash,
          at: new Date(now()).toISOString(),
          actor: opts.actor,
          decidedBy: opts.decidedBy,
        };
        await deps.storage.writeAtomic(
          amendmentAppliedPath(deps.dataDir, id),
          `${JSON.stringify(appliedMarker, null, 2)}\n`,
        );

        // 8. Compare-and-swap onto the bytes the proposal was filed against.
        try {
          await registry.writeDefinitionBytes(
            record.personalityId,
            fileOf(record),
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
            `${fileOf(record)} changed while applying; nothing was written`,
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
        await clearBirthOnIdentity(record);
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
        // Declining a change that is already live would leave `declined` over
        // the approved bytes with no way to roll them back (C4).
        const target = await mutableTarget(record);
        if (target.ok) {
          const live = await deps.storage.read(target.path);
          const liveHash = live === null ? null : hashDefinitionBytes(live);
          if (await interruptedMarker(record, liveHash)) {
            return {
              ok: false,
              code: 'not_pending',
              reason:
                `an earlier apply of ${id} already wrote ${fileOf(record)}; run apply to record it, ` +
                'then rollback to undo it',
            };
          }
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
              `${fileOf(record)} changed since this amendment was applied (a later amendment or ` +
              'an edit); roll that back first',
          };
        }
        // The snapshot lives in the amendment's own directory (by id); its
        // hash must be the base the proposal was filed against.
        const prior = await deps.storage.read(amendmentPriorPath(deps.dataDir, id, fileOf(record)));
        if (prior === null || hashDefinitionBytes(prior) !== record.baseHash) {
          return {
            ok: false,
            code: 'prior_missing',
            reason: `the prior ${fileOf(record)} snapshot for ${id} is missing or does not match`,
          };
        }
        // The record binds the two ends (C5): its ops are the canonical ops it
        // was filed with, and they turn the prior snapshot into exactly the
        // bytes this apply wrote. A record or snapshot edited on disk fails
        // here, so rollback restores only what this amendment replaced.
        const canonical = canonicalizeAmendmentOps(record.target, record.ops);
        const replayed = applyTargetOps(record.target, prior, record.ops);
        if (
          !canonical.ok ||
          opsHash(canonical.ops) !== record.opsHash ||
          !replayed.ok ||
          hashDefinitionBytes(replayed.afterBytes) !== appliedHash
        ) {
          return {
            ok: false,
            code: 'record_mismatch',
            reason: `amendment ${id} does not match the bytes it applied, so nothing was rolled back`,
          };
        }
        // An identity rollback restores lines the constitution never reads
        // (`configAfter`), so the live definition stands in for the prior one.
        const constitution = await checkConstitution(
          deps,
          record.target === 'toolset'
            ? { ...described.config, toolset: parseToolsetYaml(prior) }
            : described.config,
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
          await registry.writeDefinitionBytes(record.personalityId, fileOf(record), prior, {
            expectedHash: appliedHash,
          });
        } catch (err) {
          if (!(err instanceof DefinitionChangedError)) throw err;
          return {
            ok: false,
            code: 'live_edited',
            reason: `${fileOf(record)} changed while rolling back; nothing was written`,
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

    refresh(id, opts) {
      return locked(async () => {
        const record = await readAmendment(deps.storage, deps.dataDir, id);
        if (!record) return { ok: false, code: 'not_found', reason: `no amendment ${id}` };
        if (record.status !== 'pending' && record.status !== 'stale') return { ok: true, record };
        const target = await mutableTarget(record);
        if (!target.ok) return target.result;
        const liveBytes = await deps.storage.read(target.path);
        const liveHash = liveBytes === null ? null : hashDefinitionBytes(liveBytes);
        const marker = await interruptedMarker(record, liveHash);
        if (marker) return recoverInterruptedApply(record, marker, opts);
        if (record.status === 'stale') return { ok: true, record };
        const stale = staleReason(record, liveBytes, liveHash);
        return stale ? markStale(record, opts.decidedBy, opts.actor, stale) : { ok: true, record };
      });
    },
  };
}

/** The decline reason {@link retireDeletedPersonality} records. */
export const PERSONALITY_DELETED_REASON = 'personality deleted';

/**
 * After a personality is deleted through an operator path (the web delete RPC,
 * `PersonalitiesService.delete` in apps/web-api), retire what it left under
 * `learning/`: every `pending` or `stale` amendment filed for its id goes to
 * `declined` with reason {@link PERSONALITY_DELETED_REASON}, and its birth
 * marker is removed. Without this, a personality later created with the same
 * id inherits them — a proposal written for the old one could be applied to
 * it, and a leftover marker would restart a ritual it never asked for.
 *
 * Applied, declined and rolled-back records stay as history. An `applied`
 * identity record cannot end the NEW personality's ritual, because the
 * injector counts only records filed after the current marker
 * (`createBirthRitualInjector`, ./birth-ritual.ts).
 *
 * Declines run under the amendment lock ({@link acquireAmendmentLock}), so no
 * filing, apply or decline interleaves. Pinned by 'birth ritual — a deleted
 * personality leaves nothing behind' in __tests__/birth-ritual.test.ts.
 */
export async function retireDeletedPersonality(opts: {
  storage: Storage;
  dataDir: string;
  personalityId: string;
  actor: AmendmentActor;
  decidedBy: string;
  /** Injectable for tests; defaults to {@link acquireAmendmentLock}. */
  acquireLock?: (dataDir: string) => Promise<() => void>;
  now?: () => number;
}): Promise<{ declined: string[]; markerCleared: boolean }> {
  const { storage, dataDir, personalityId } = opts;
  const release = await (opts.acquireLock ?? acquireAmendmentLock)(dataDir);
  const declined: string[] = [];
  try {
    const open = await listAmendments(storage, dataDir, {
      personalityId,
      status: ['pending', 'stale'],
    });
    for (const record of open) {
      await transitionAmendment(
        storage,
        dataDir,
        record.id,
        {
          to: 'declined',
          actor: opts.actor,
          decidedBy: opts.decidedBy,
          reason: PERSONALITY_DELETED_REASON,
        },
        opts.now,
      );
      declined.push(record.id);
    }
  } finally {
    release();
  }
  const markerCleared = await clearBirthMarker(storage, dataDir, personalityId);
  return { declined, markerCleared };
}
