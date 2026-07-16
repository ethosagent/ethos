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
 * A synthetic background-job wake is injected as a `[background job … finished]`
 * envelope wrapping the child's summary in an `<untrusted tool="background_job_summary">`
 * block (see `Gateway.buildWakeNotice`). The wake body is untrusted child output;
 * capturing from it would let hostile content a child read reach durable memory.
 */
function isWakeTurn(initialPrompt: string): boolean {
  return (
    initialPrompt.startsWith('[background job ') ||
    initialPrompt.includes('tool="background_job_summary"')
  );
}

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  if (input.isDryRun) return { eligible: false, reason: 'dry-run' };

  const sessionKey = input.sessionKey;
  if (sessionKey.startsWith('dream:')) return { eligible: false, reason: 'dream-session' };
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
