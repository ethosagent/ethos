export {
  aggregateByCategory,
  type CategoryStat,
  categoryOf,
  type RepairEvent,
  type RepairSummary,
  summarizeRepairs,
} from './local-report';
export { EvalRunner, parseExpectedJsonl } from './runner';
export {
  containsScorer,
  exactMatchScorer,
  llmJudgeScorer,
  regexScorer,
  type Scorer,
} from './scorers';
export type { EvalExpected, EvalRunOptions, EvalStats } from './types';
