// Public entry point. The package exports a `SlackAdapter` class and a few
// pure helpers so wiring (and tests) can construct adapters without
// reaching into the internal directory layout.
//
// The actual `PlatformAdapter` implementation lives in `./adapter` —
// keeping `index.ts` a thin barrel makes it easy to refactor internals
// without rippling through every consumer.
export { SlackAdapter } from './adapter';
export {
  APPROVE_ACTION_ID,
  approvalPendingBlocks,
  approvalResolvedBlocks,
  DENY_ACTION_ID,
} from './blocks/approval';
export { chunkText, reflowChunks } from './chunking';
export { ChannelModeSchema, DEFAULT_CHANNEL_MODE } from './config';
export { buildHomeView } from './home/view';
