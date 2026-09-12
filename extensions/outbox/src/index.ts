// @ethosagent/outbox — the personality approval outbox.
//
// `hash.ts` computes the publication binding, `store.ts` holds it durably and
// enforces it in conditional UPDATEs, `service.ts` is the lifecycle and the
// audit trail. Nothing here knows about adapters, personalities or tools: the
// gateway dispatcher and the `send_message` gate wire those in from above.

export { type ContentHashInput, canonicalizeContent, computeContentHash } from './hash';
export {
  type ApproveInput,
  type BoundPublication,
  type DecisionInput,
  type EditInput,
  type ExpiryReport,
  LEGAL_FROM,
  OUTBOX_AUDIT_CODES,
  type OutboxAction,
  type OutboxDecision,
  type OutboxErrorCode,
  type OutboxObservability,
  type OutboxResult,
  OutboxService,
  type OutboxServiceOptions,
  type RejectInput,
} from './service';
export {
  ACTIVE_STATES,
  APPROVAL_VALIDITY_MS,
  type OutboxItem,
  type OutboxRevision,
  type OutboxState,
  type OutboxStore,
  PENDING_EXPIRY_MS,
  type ProposeInput,
  type ProposeResult,
  type ReviewReceipt,
  type ReviewVerdict,
  SQLiteOutboxStore,
  STALE_THRESHOLD_MS,
} from './store';
