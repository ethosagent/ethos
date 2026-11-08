import {
  ARGV_FS_DENY_PATTERNS,
  approvalRequiredReason,
  checkCommand,
  createTerminalGuardHook,
  type GuardHookOptions,
} from '@ethosagent/tools-terminal';
import type { BeforeToolCallPayload, BeforeToolCallResult } from '@ethosagent/types';

// `process_start` runs `spawn(command, [], { shell: true })` (see ./spawn.ts) with an
// LLM-controlled `command` string, the same exposure as the `terminal` tool. There is
// ONE hardline blocklist, the terminal guard's (`@ethosagent/tools-terminal` guard.ts):
// its PATTERNS, APPROVAL_PATTERNS, ARGV_FS_DENY_PATTERNS and inline-eval tokenizer. This
// module only re-exports it and binds the hook to the `process_start` tool name; it was
// a verbatim copy until the two files were verified identical and merged. Pinned by
// guard.test.ts and deny-manifest-parity.test.ts in this package.
export { ARGV_FS_DENY_PATTERNS, approvalRequiredReason, checkCommand, type GuardHookOptions };

/**
 * The hard-blocking `before_tool_call` guard for `process_start`. An
 * approval-required command (`approvalRequiredReason`) is refused too unless
 * `opts.approvalGated` says a host approval gate covers this loop.
 */
export const createProcessGuardHook = (
  opts: GuardHookOptions = {},
): ((payload: BeforeToolCallPayload) => Promise<Partial<BeforeToolCallResult> | null>) =>
  createTerminalGuardHook(['process_start'], opts);
