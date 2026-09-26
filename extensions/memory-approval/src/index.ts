export { isGated, PendingMemoryGate, type WithPendingGateOptions, withPendingGate } from './gate';
export {
  EVIDENCE_APPROVER,
  MAX_EVIDENCE_SESSIONS,
  PendingMemoryStore,
  type PendingMemoryStoreOptions,
  scopeDir,
  TombstoneStore,
  type TombstoneStoreOptions,
} from './store';
export type {
  ApplyFn,
  MemoryApprovalMode,
  PendingEntry,
  PendingGateObservability,
  ProposeInput,
  TombstoneRecord,
} from './types';
