import { denyRuleReason, matchDenyRule } from '@ethosagent/core';
import type { Logger, PersonalityConfig } from '@ethosagent/types';

/**
 * One interception of a Pi tool call, as it reaches the host.
 *
 * Pi has NO permission system for its own built-in tools — `bash`/`edit`/
 * `write`/`read` execute unconditionally. The only interception point that
 * exists is the extension API: a `tool_call` handler that can `block`, calling
 * `ctx.ui.*` to ask the host first. So this request did not come from Pi; it
 * came from the gate extension WE ship and mount into the container.
 */
export interface PiGateRequest {
  /** `extension_ui_request.id` — the correlation id the answer must carry back. */
  requestId: string;
  /**
   * The run this tool call belongs to. Pi's frame does not carry it — the host
   * stamps it from its own spec — but every policy above a single run needs
   * it: the router's answer scope is per-job (D17), and a clarify's lane is
   * the job (G1). Without it a gate can only make one decision for everyone.
   */
  jobId: string;
  /** The dialog method Pi used. One of `PI_RUNNER_CAPABILITIES.interactionKinds`. */
  kind: string;
  /** The tool Pi is about to run. */
  toolName: string;
  /** Compact, truncated digest of the tool input — legible, never authoritative. */
  digest: string;
  /**
   * The tool input itself, untruncated, as the gate extension sent it — what
   * `createPersonalityGate` matches deny rules against. Absent when the title
   * carried no input line (`parseGateTitle`).
   */
  input?: unknown;
}

export interface PiGateAnswer {
  allow: boolean;
  /** Surfaced to the model as the block reason when `allow` is false. */
  reason?: string;
}

/**
 * The single decision point for "may this tool call proceed".
 *
 * Isolated on purpose: Phase 4 replaces THIS function with the real router
 * (`packages/worker-router` — capability registry, scope cache, ClarifyBridge
 * escalation) and touches nothing else in the transport. Everything around it
 * — framing, correlation, the round-trip — already works and does not need to
 * be rediscovered then.
 */
export type PiGatePolicy = (req: PiGateRequest) => Promise<PiGateAnswer>;

/** Wire prefix the gate extension puts on every dialog title. */
const TITLE_PREFIX = 'ethos:tool_call:';

/**
 * Parse the gate extension's dialog title back into a request.
 *
 * The title is the ONLY channel Pi's dialog methods give us for payload
 * (`select` carries a title and options, nothing else), so the extension
 * encodes `ethos:tool_call:<toolName>\n<digest>\n<input JSON>` and this reads
 * it back. Neither the digest (whitespace-collapsed) nor `JSON.stringify`
 * output contains a raw newline, so the split is unambiguous. A title that is
 * not ours returns null — another extension's dialog is not the gate's to
 * answer.
 */
export function parseGateTitle(
  title: string | undefined,
): { toolName: string; digest: string; input?: unknown } | null {
  if (!title?.startsWith(TITLE_PREFIX)) return null;
  const [toolName = '', digest = '', inputLine] = title.slice(TITLE_PREFIX.length).split('\n');
  if (inputLine === undefined) return { toolName, digest };
  try {
    return { toolName, digest, input: JSON.parse(inputLine) };
  } catch {
    return { toolName, digest };
  }
}

/**
 * Pi tool name → the Ethos tools that do the same thing (S12, plan
 * openclaw-2026.9.6-gaps). Pi's built-ins are the runner's `--tools` list
 * (`DEFAULT_PI_TOOLS` in `src/runner.ts`, operator-overridable):
 *
 * | Pi tool | Ethos tools                  |
 * |---------|------------------------------|
 * | `read`  | `read_file`                  |
 * | `bash`  | `terminal`                   |
 * | `write` | `write_file`                 |
 * | `edit`  | `patch_file`, `write_file`   |
 * | `grep`  | `search_files`               |
 * | `find`  | `search_files`               |
 * | `ls`    | `read_file`, `search_files`  |
 * | other   | none                         |
 *
 * Several-tool rows fail CLOSED for deny rules (a rule matching ANY of them
 * refuses) and open for the toolset (ANY of them in the toolset permits).
 * Enforced by `personalityRefusal` below; pinned by the `createPersonalityGate`
 * cases in `src/__tests__/runner.test.ts`.
 */
const PI_TOOL_TO_ETHOS_TOOLS: ReadonlyMap<string, readonly string[]> = new Map([
  ['read', ['read_file']],
  ['bash', ['terminal']],
  ['write', ['write_file']],
  ['edit', ['patch_file', 'write_file']],
  ['grep', ['search_files']],
  ['find', ['search_files']],
  ['ls', ['read_file', 'search_files']],
]);

export type PiGatePersonality = Pick<PersonalityConfig, 'id' | 'toolset' | 'safety'>;

/** Why this personality refuses the call, or `undefined` if it does not. */
function personalityRefusal(
  personality: PiGatePersonality,
  req: PiGateRequest,
): string | undefined {
  const mapped = PI_TOOL_TO_ETHOS_TOOLS.get(req.toolName) ?? [];
  // Deny rules: every Ethos name the tool maps to, plus Pi's own name, against
  // the full input — the digest only when an older extension sent no input.
  const args = req.input ?? req.digest;
  for (const name of [...mapped, req.toolName]) {
    const rule = matchDenyRule(personality.safety?.denyRules, name, args);
    if (rule) return denyRuleReason(rule);
  }
  // Toolset: only a tool with an Ethos analogue can be checked; any other goes
  // to the inner gate (the router, or a human) as before.
  const toolset = personality.toolset;
  if (toolset && mapped.length > 0 && !mapped.some((t) => toolset.includes(t))) {
    return `Pi tool "${req.toolName}" maps to ${mapped.join(', ')}, none of which is in personality "${personality.id}"'s toolset`;
  }
  return undefined;
}

/**
 * Bind a delegated Pi run to the delegating personality's deny rules and
 * toolset — the floor the in-process loop applies in `enforceBeforeToolCall`
 * (`packages/core`) and the tool registry, which Pi's own process never
 * crosses. Checked BEFORE `inner` (auto-approve or the router), so no cached
 * answer or human can approve past it. `PiJobRunner` wraps its gate in this
 * per run (`src/runner.ts`). The reason is logged; Pi's model sees only the
 * extension's fixed "Blocked by Ethos policy", because `runPiHost` answers the
 * dialog with `allow`/`deny` alone.
 */
export function createPersonalityGate(
  inner: PiGatePolicy,
  personality: PiGatePersonality,
  logger?: Logger,
): PiGatePolicy {
  return async (req) => {
    const reason = personalityRefusal(personality, req);
    if (!reason) return inner(req);
    logger?.info('pi gate: refused by personality policy', {
      jobId: req.jobId,
      requestId: req.requestId,
      personalityId: personality.id,
      reason,
    });
    return { allow: false, reason };
  };
}

/**
 * Phase 2's policy: approve everything, and say so.
 *
 * Deliberately not a decision engine. Containment for a Pi run is the container
 * boundary (D4), not this gate — the gate exists so Phase 4 has a live,
 * proven interception seam to route through. A gate that quietly made policy
 * now would be a second, weaker boundary nobody reviewed.
 */
export function createAutoApproveGate(logger?: Logger): PiGatePolicy {
  return async (req) => {
    logger?.debug('pi gate: auto-approved tool call', {
      requestId: req.requestId,
      kind: req.kind,
      toolName: req.toolName,
      digest: req.digest,
    });
    return { allow: true };
  };
}
