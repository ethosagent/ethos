// @ethosagent/surface-kit — shared surface primitives.
//
// (1) A typed AgentEvent translator: the common fold every surface performs
//     over `AgentLoop.run()`, plus the tool-progress audience gate.
// (2) The reconciled slash-command definitions: one typed registry surfaces
//     share for names/aliases/descriptions/usage and parsing.
//
// LAYER: depends only on `@ethosagent/types`, so any surface (app or
// extension) can import it without introducing a cycle.

export {
  createEventTranslator,
  type EventTranslator,
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
