export type {
  CompoundingErrorOptions,
  RateLimitOptions,
  SequenceRuleOptions,
  TokenBudgetOptions,
} from './rules';
export {
  compoundingErrorRule,
  defaultRules,
  EXFIL_TOOL_NAMES,
  isExfilShapedTool,
  rateLimitRule,
  suspiciousSequenceRule,
  tokenBudgetRule,
} from './rules';
export type { WatcherDecision, WatcherEvent, WatcherRule, WatcherState } from './types';
export { makeInitialState } from './types';
export { Watcher, type WatcherObservability, type WatcherOptions } from './watcher';
