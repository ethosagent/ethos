// Public entry point. The package exports a `SlackAdapter` class and a few
// pure helpers so wiring (and tests) can construct adapters without
// reaching into the internal directory layout.
//
// The actual `PlatformAdapter` implementation lives in `./adapter` —
// keeping `index.ts` a thin barrel makes it easy to refactor internals
// without rippling through every consumer.

export type {
  AdapterCapabilities,
  ApprovalCapableAdapter,
  ApprovalDecisionEvent,
} from '@ethosagent/types';
export type { SlackAdapterConfig } from './adapter';
export { SlackAdapter } from './adapter';
export {
  APPROVE_ACTION_ID,
  approvalPendingBlocks,
  approvalResolvedBlocks,
  DENY_ACTION_ID,
} from './blocks/approval';
export type { KanbanTicket } from './blocks/kanban';
export type { SessionSummary } from './blocks/session';
export type {
  KanbanUnfurlData,
  PersonalityUnfurlData,
  SessionUnfurlData,
} from './blocks/unfurl';
export { chunkText, reflowChunks } from './chunking';
export { classifyChannelError } from './classify-error';
export type { KanbanReader, MemoryReader } from './commands';
export {
  type Binding,
  type ChannelMode,
  ChannelModeSchema,
  DEFAULT_CHANNEL_MODE,
} from './config';
export type {
  KanbanUnfurlReader,
  PersonalityUnfurlReader,
  SessionUnfurlReader,
} from './events/links';
export type { SessionReader } from './home/handlers';
export { buildHomeView, type HomeViewInput, type SlackHomeView } from './home/view';
