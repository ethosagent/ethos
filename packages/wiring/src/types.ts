// `WiringContext` is a contract (extensions' `compose()` functions take it),
// so it lives in `@ethosagent/types` (packages/types/src/wiring-context.ts).
// Re-exported here so existing `@ethosagent/wiring/types` callers keep working.
export type { WiringContext } from '@ethosagent/types';
