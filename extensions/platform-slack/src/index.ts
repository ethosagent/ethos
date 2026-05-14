// Public entry point. The package exports a `SlackAdapter` class and a few
// pure helpers so wiring (and tests) can construct adapters without
// reaching into the internal directory layout.
//
// The actual `PlatformAdapter` implementation lives in `./adapter` —
// keeping `index.ts` a thin barrel makes it easy to refactor internals
// without rippling through every consumer.

export type { SlackAdapterConfig } from './adapter';
export { SlackAdapter } from './adapter';
export type { KanbanTicket } from './blocks/kanban';
export { chunkText, reflowChunks } from './chunking';
export type { KanbanReader, MemoryReader } from './commands';
export {
  type Binding,
  type ChannelMode,
  ChannelModeSchema,
  DEFAULT_CHANNEL_MODE,
} from './config';
