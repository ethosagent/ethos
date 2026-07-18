export type {
  ConsolidationInput,
  ConsolidationResult,
  ScoredSection,
} from './memory-consolidation';
export {
  buildConsolidationUpdates,
  consolidateMemory,
  slugify,
} from './memory-consolidation';
export type {
  ArchiveBlock,
  ConsolidationPlan,
  DecayConfig,
  DecayParams,
  MemoryMeta,
  MetaEntry,
} from './memory-decay';
export {
  DEFAULT_DECAY_CONFIG,
  emptyMeta,
  formatArchiveBlock,
  parseArchiveBlocks,
  parseMemoryMeta,
  planConsolidation,
  renderSection,
  resolveDecayParams,
} from './memory-decay';
export type {
  LifecycleResult,
  RetractDeps,
  SupersedeDeps,
} from './memory-lifecycle';
export { retractSlug, supersedeSlug } from './memory-lifecycle';
export type { RestoreResult } from './memory-restore';
export { restoreArchivedSlug } from './memory-restore';
export type {
  NightlyEvidence,
  NightlyGates,
  NightlyPassDeps,
  NightlyPassResult,
  NightlyState,
  NightlyStepLog,
} from './orchestrator';
export { runNightlyPass } from './orchestrator';
