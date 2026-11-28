import type { LLMProvider, ModelTierName, Storage } from '@ethosagent/types';

export interface EvalExpected {
  id: string;
  expected: string;
  match?: 'exact' | 'contains' | 'regex' | 'llm';
}

export interface EvalRunOptions {
  concurrency: number;
  outputPath: string;
  defaultScorer: 'exact' | 'contains' | 'regex' | 'llm';
  llmProvider?: LLMProvider;
  /** Storage backend. Injected by the composition root; required — never
   *  falls back to raw disk. */
  storage: Storage;
  /** Force every task onto this tier (`/tier deep` for the whole run) — the
   *  always-deep arm of the escalation comparison. */
  tierOverride?: ModelTierName;
}

export interface EvalStats {
  total: number;
  passed: number;
  failed: number;
  avgScore: number;
}
