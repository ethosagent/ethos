// Eligibility filter (§3.2) — the free, pre-LLM gate. Every exclusion here
// runs before any model call, so an ineligible turn costs nothing.

export type ExclusionReason =
  | 'user-text-too-short'
  | 'tool-only'
  | 'dream-session'
  | 'child-session'
  | 'wake-turn'
  | 'dry-run';

export interface EligibilityInput {
  sessionKey: string;
  /** First user message of the turn. */
  initialPrompt: string;
  /** Final assistant text of the turn. */
  finalText: string;
  isDryRun: boolean;
  minUserChars: number;
}

export interface EligibilityResult {
  eligible: boolean;
  reason?: ExclusionReason;
}

/**
 * Derived child session keys share the parent's memory scope. Capturing from
 * them would fire multiple writes for one logical conversation (a single
 * `mixture_of_agents` call spawns several children) and would let untrusted
 * child output persist — so any turn whose key carries one of these segments
 * is excluded. Segments match the delegation conventions in
 * `extensions/tools-delegation` (`:sub:`, `:moa:`, `:job:`) and `:mesh:`.
 */
const CHILD_SEGMENTS = [':sub:', ':moa:', ':job:', ':mesh:'];

/**
 * Anchored match for the untrusted background-job wrapper: the opening tag of an
 * `<untrusted source="…" tool="background_job_summary">` block emitted by
 * `wrapUntrusted` (see `packages/safety/injection/src/wrap.ts`). Matching the
 * tag structure (rather than a bare `includes`) means a hostile child echoing
 * the literal attribute in prose still trips it — over-exclusion is safe — while
 * the check stays pinned to the real envelope shape.
 */
const BACKGROUND_JOB_UNTRUSTED_TAG = /<untrusted\b[^>]*\btool="background_job_summary"/;

/**
 * A synthetic background-job wake is a `[background job … finished]` envelope
 * wrapping the child's summary in an `<untrusted tool="background_job_summary">`
 * block (see `Gateway.buildWakeNotice`). The wake body is untrusted child output.
 *
 * This is DEFENCE-IN-DEPTH, not the primary guarantee. Today no path re-ingests
 * a wake as a parent turn: the gateway sends the notice outbound via
 * `adapter.send` and the CLI prints it at the idle prompt ("no auto-turn"), so a
 * wake never fires `agent_done` with a parent's sessionKey. Every child turn
 * that DOES fire `agent_done` carries a derived child sessionKey (`:job:` /
 * `:sub:` / `:moa:` / `:mesh:`) and is excluded structurally below, regardless
 * of its content. This content check only guards a hypothetical future path that
 * injects wake text as a parent turn; it must never be relied on as the sole
 * barrier, because content markers are attacker-influenceable.
 */
function isWakeTurn(initialPrompt: string): boolean {
  return (
    initialPrompt.startsWith('[background job ') || BACKGROUND_JOB_UNTRUSTED_TAG.test(initialPrompt)
  );
}

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  if (input.isDryRun) return { eligible: false, reason: 'dry-run' };

  const sessionKey = input.sessionKey;
  if (sessionKey.startsWith('dream:')) return { eligible: false, reason: 'dream-session' };
  // PRIMARY guarantee: any child/background turn is excluded by the STRUCTURAL
  // shape of its derived sessionKey, independent of (attacker-influenceable)
  // content. This is what actually keeps untrusted child output out of durable
  // memory. The content-based `isWakeTurn` check below is belt-and-braces.
  for (const seg of CHILD_SEGMENTS) {
    if (sessionKey.includes(seg)) return { eligible: false, reason: 'child-session' };
  }

  if (isWakeTurn(input.initialPrompt)) return { eligible: false, reason: 'wake-turn' };

  // Tool-only turns end with no natural-language response — nothing durable to
  // extract from the dialogue.
  if (input.finalText.trim().length === 0) return { eligible: false, reason: 'tool-only' };

  if (input.initialPrompt.trim().length < input.minUserChars) {
    return { eligible: false, reason: 'user-text-too-short' };
  }

  return { eligible: true };
}
