import type { ToolResult } from '@ethosagent/types';

// The routing arguments of `delegate_task` that only make sense on a background
// job (`deliver`, `resume_on_restart`): their schema and their up-front checks.
// Pinned by `__tests__/background-tools.test.ts` (deliver) and
// `__tests__/resume-on-restart-arg.test.ts`.

/** JSON-schema `properties` spread into `delegate_task`'s `inputSchema`. */
export const BACKGROUND_ROUTING_PROPERTIES = {
  deliver: {
    type: 'string',
    enum: ['user', 'parent'],
    description:
      "Who sees the result first. Only valid with background: true. 'user' (default) sends the result to the chat as-is. " +
      "'parent' lets you review the result in one follow-up turn on a channel chat first, and the user sees your reply instead.",
  },
  resume_on_restart: {
    type: 'boolean',
    description:
      'Only valid with background: true. Default true: if Ethos restarts or crashes while the job runs, it continues on its own session afterwards. false: the job ends instead.',
  },
} as const;

/**
 * Refuse a background-only argument on a blocking call, a bad value, or a chained
 * parent review. Undefined when everything is valid.
 */
export function validateBackgroundRouting(args: {
  deliver: unknown;
  resumeOnRestart: unknown;
  runInBackground: boolean | undefined;
  reviewOfJobId: string | undefined;
}): ToolResult | undefined {
  const { deliver, resumeOnRestart, runInBackground, reviewOfJobId } = args;
  const invalid = (error: string): ToolResult => ({ ok: false, code: 'input_invalid', error });
  // `deliver` routes a background result; a blocking call returns its
  // result to this turn already. Refused like `runner` rather than ignored.
  if (deliver !== undefined && runInBackground !== true) {
    return invalid('deliver is only valid with background: true');
  }
  if (deliver !== undefined && deliver !== 'user' && deliver !== 'parent') {
    return invalid("deliver must be 'user' or 'parent'");
  }
  // One review hop, never a chain (plan openclaw-9.5-adoption D10/D30): a
  // parent-review turn carries `reviewOfJobId` (RunOptions → ToolContext).
  if (deliver === 'parent' && reviewOfJobId !== undefined) {
    return invalid('a review turn cannot request another parent review');
  }
  if (resumeOnRestart !== undefined && runInBackground !== true) {
    return invalid('resume_on_restart is only valid with background: true');
  }
  if (resumeOnRestart !== undefined && typeof resumeOnRestart !== 'boolean') {
    return invalid('resume_on_restart must be a boolean');
  }
  return undefined;
}
