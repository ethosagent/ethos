export { hashFact, normalizeFact } from './dedup';
export { type EligibilityInput, type EligibilityResult, evaluateEligibility } from './eligibility';
export { extractFacts, parseFacts } from './extraction';
export {
  type ConsolidateFn,
  MemoryCaptureRunner,
  type MemoryCaptureRunnerOptions,
} from './runner';
export {
  type CaptureConfig,
  type CaptureFact,
  type CaptureJob,
  type CaptureNotice,
  DEFAULT_CAPTURE_CONFIG,
} from './types';
