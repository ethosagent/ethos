// @ethosagent/surface-kit — shared surface primitives.
//
// (1) A typed AgentEvent translator: the common fold every surface performs
//     over `AgentLoop.run()`, plus the tool-progress audience gate.
// (2) The reconciled slash-command definitions: one typed registry surfaces
//     share for names/aliases/descriptions/usage and parsing.
// (3) The approval-card args formatter every channel adapter shares
//     (`formatApprovalArgs`, ./approval-args.ts).
//
// LAYER: depends only on `@ethosagent/types` and the dependency-free
// `@ethosagent/safety-redact` (security kernel), so any surface (app or
// extension) can import it without introducing a cycle.

export {
  type ApprovalArgsFormat,
  formatApprovalArgs,
  TRUNCATED_MARKER,
  truncateWithMarker,
} from './approval-args';
export { BRANCH_USAGE, formatBranchList, pickBranch } from './branches';
export {
  CHAT_ERROR_MAP,
  type ChatErrorDescription,
  type ChatErrorEntry,
  describeChatError,
} from './chat-errors';
export {
  createEventTranslator,
  credentialInstruction,
  credentialSetCommand,
  type EventTranslator,
  type EventTranslatorCredentialRequired,
  type EventTranslatorDone,
  type EventTranslatorError,
  type EventTranslatorHalt,
  type EventTranslatorOptions,
  type EventTranslatorUsage,
  shouldSurfaceProgress,
  type ToolCallState,
} from './event-translator';
export {
  getSlashCommand,
  type ParsedSlashCommand,
  parseSlashCommand,
  resolveSlashCommand,
  SLASH_COMMANDS,
  type SlashCommandDef,
  type SlashSurface,
  slashCommandsForSurface,
} from './slash-commands';
