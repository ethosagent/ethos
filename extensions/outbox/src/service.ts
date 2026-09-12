import { computeContentHash } from './hash';
import type {
  OutboxItem,
  OutboxRevision,
  OutboxState,
  OutboxStore,
  ProposeInput,
  ProposeResult,
  ReviewReceipt,
} from './store';

// ---------------------------------------------------------------------------
// OutboxService — the state machine, and the audit trail of human decisions
//
// The store holds the SQL; this holds the rules. Two layers because they answer
// two different questions. The store's conditional UPDATEs answer "is this
// still true right now" — a race against a peer process or a second tab. This
// layer answers "is this move legal at all", which is a fact about the
// lifecycle and does not need a database round trip to decide.
//
// Both answers reach the caller, distinguished: `illegal_transition` means the
// action was never available from that state; `conflict` means it was, and
// something moved underneath the caller. Collapsing the two would hand a UI
// "changed since you viewed it" for a button that should never have rendered.
// ---------------------------------------------------------------------------

/**
 * The audit sink, declared STRUCTURALLY rather than imported.
 *
 * `packages/wiring`'s `EthosObservability` satisfies it, and so does
 * web-api's local `ApprovalObservability` — the same precedent that file sets.
 * An import would point this extension at a package above it in the layer
 * model (ARCHITECTURE.md §II).
 */
export interface OutboxObservability {
  recordSafetyApproval(opts: {
    decision: 'approved' | 'denied' | 'auto';
    severity?: 'info' | 'warn';
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
}

/**
 * The five human decisions, and the audit code each one writes.
 *
 * They land in `ethos audit decisions` next to tool approvals, which is the
 * point: "what did a human let this agent do" is one question, not two.
 */
export const OUTBOX_AUDIT_CODES = {
  approve: 'outbox.approve',
  reject: 'outbox.reject',
  edit: 'outbox.edit',
  revoke: 'outbox.revoke',
  retry: 'outbox.retry',
} as const;

export type OutboxDecision = keyof typeof OUTBOX_AUDIT_CODES;

/**
 * How each decision maps onto `recordSafetyApproval`'s three-value `decision`
 * field, which was written for tool approvals and admits only
 * `approved | denied | auto`.
 *
 * `edit` and `revoke` both read as `denied` because both say the same thing
 * about the text as it stands: it is not going out. The `code` is what
 * separates them, and an auditor filtering for "what actually got published"
 * wants the `approved` rows, which these are not. Nothing here is ever `auto` —
 * the whole point of the outbox is that a human decided (O-D4).
 */
const AUDIT_DECISION: Record<OutboxDecision, 'approved' | 'denied'> = {
  approve: 'approved',
  reject: 'denied',
  edit: 'denied',
  revoke: 'denied',
  retry: 'approved',
};

const AUDIT_SEVERITY: Record<OutboxDecision, 'info' | 'warn'> = {
  approve: 'info',
  // A refusal and a withdrawal are the two decisions an operator scanning the
  // trail is looking for; an edit and a re-approve are routine.
  reject: 'warn',
  edit: 'info',
  revoke: 'warn',
  retry: 'info',
};

/** Every move the lifecycle admits, human or machine. */
export type OutboxAction =
  | 'review'
  | 'approve'
  | 'edit'
  | 'reject'
  | 'revoke'
  | 'retry'
  | 'claim'
  | 'release'
  | 'sent'
  | 'unconfirmed'
  | 'fail';

/**
 * The lifecycle as a table — the states each action may be taken FROM.
 *
 * This is the single declaration of the diagram in `store.ts`'s
 * {@link OutboxState} docs, and the table test walks it exhaustively: for every
 * (state, action) pair not listed here, the service refuses.
 */
export const LEGAL_FROM: Record<OutboxAction, readonly OutboxState[]> = {
  review: ['awaiting_review'],
  approve: ['awaiting_approval'],
  edit: ['awaiting_approval'],
  reject: ['awaiting_approval'],
  revoke: ['approved'],
  retry: ['failed'],
  claim: ['approved'],
  release: ['sending'],
  sent: ['sending'],
  unconfirmed: ['sending'],
  fail: ['sending'],
};

export type OutboxErrorCode = 'not_found' | 'conflict' | 'illegal_transition' | 'binding_mismatch';

/** Mirrors the repo's `ToolResult` shape so a surface can forward it directly. */
export type OutboxResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: OutboxErrorCode; error: string };

function ok<T>(value: T): OutboxResult<T> {
  return { ok: true, value };
}

function err<T>(code: OutboxErrorCode, error: string): OutboxResult<T> {
  return { ok: false, code, error };
}

/** What a stale approve is told. The wording is the contract with the UI. */
const CONFLICT_MESSAGE = 'changed since you viewed it';

export interface ApproveInput {
  itemId: string;
  /** The revision the approver read. */
  revision: number;
  /** The hash of the revision the approver read. */
  contentHash: string;
  decidedBy: string;
}

export interface EditInput {
  itemId: string;
  /** The revision the editor started from. */
  revision: number;
  text: string;
  decidedBy: string;
}

export interface RejectInput {
  itemId: string;
  reason: string;
  decidedBy: string;
}

export interface DecisionInput {
  itemId: string;
  decidedBy: string;
}

/** What `verifyBinding` hands the dispatcher: the exact bytes to send. */
export interface BoundPublication {
  item: OutboxItem;
  revision: OutboxRevision;
}

export interface ExpiryReport {
  /** Items that timed out waiting for a human. */
  pending: number;
  /** Approvals nobody delivered inside the validity window. */
  approvals: number;
}

export interface OutboxServiceOptions {
  store: OutboxStore;
  /**
   * Sink for the safety audit trail. Optional — absent means no audit rows,
   * never a broken decision. Same posture as `ApprovalsService`.
   */
  observability?: OutboxObservability;
  /** Injectable clock. Tests drive the 7-day / 24h / 10-minute windows. */
  now?: () => number;
}

export class OutboxService {
  private readonly store: OutboxStore;
  private readonly observability?: OutboxObservability;
  private readonly now: () => number;

  constructor(opts: OutboxServiceOptions) {
    this.store = opts.store;
    this.observability = opts.observability;
    this.now = opts.now ?? (() => Date.now());
  }

  // -- proposal -------------------------------------------------------------

  /**
   * Queue a publication. Never writes an audit row: nobody decided anything
   * yet, and a proposal that is only ever rejected is not a permission event.
   */
  propose(input: ProposeInput): ProposeResult {
    return this.store.propose(input, this.now());
  }

  get(itemId: string): OutboxItem | null {
    return this.store.get(itemId);
  }

  getRevision(itemId: string, revision: number): OutboxRevision | null {
    return this.store.getRevision(itemId, revision);
  }

  listRevisions(itemId: string): OutboxRevision[] {
    return this.store.listRevisions(itemId);
  }

  listByPersonality(personalityId: string, limit?: number): OutboxItem[] {
    return this.store.listByPersonality(personalityId, limit);
  }

  listByState(states: readonly OutboxState[], limit?: number): OutboxItem[] {
    return this.store.listByState(states, limit);
  }

  // -- reviewer -------------------------------------------------------------

  /**
   * Attach the advisory reviewer's receipt and release the item to the human.
   *
   * The verdict never blocks and never approves (O-D4): a `fail` receipt still
   * reaches the human, who is the only one who can approve. A reviewer that
   * could block would leave items stuck with nobody able to unstick them.
   */
  attachReview(itemId: string, receipt: ReviewReceipt): OutboxResult<OutboxItem> {
    const guard = this.guard(itemId, 'review');
    if (!guard.ok) return guard;
    if (!this.store.attachReview(itemId, receipt, this.now())) {
      return err('conflict', CONFLICT_MESSAGE);
    }
    return this.reread(itemId);
  }

  // -- human decisions ------------------------------------------------------

  /**
   * Approve exactly one revision of one text.
   *
   * The revision and hash the approver read travel into the store's conditional
   * UPDATE; if they no longer match the row, nothing is approved and the caller
   * gets `conflict`. No audit row is written for a conflict — nobody decided
   * anything.
   */
  approve(input: ApproveInput): OutboxResult<OutboxItem> {
    const guard = this.guard(input.itemId, 'approve');
    if (!guard.ok) return guard;
    const changed = this.store.approve(
      input.itemId,
      input.revision,
      input.contentHash,
      input.decidedBy,
      this.now(),
    );
    if (!changed) return err('conflict', CONFLICT_MESSAGE);
    const after = this.reread(input.itemId);
    if (after.ok) {
      this.audit('approve', after.value, input.decidedBy, `approved revision ${input.revision}`);
    }
    return after;
  }

  /**
   * Replace the text with revision n+1. Any approval on revision n is void —
   * the store clears the approval columns in the same UPDATE that bumps the
   * revision, so there is no window where an old approval points at new text.
   */
  edit(input: EditInput): OutboxResult<OutboxItem> {
    const guard = this.guard(input.itemId, 'edit');
    if (!guard.ok) return guard;
    const item = this.store.edit(
      input.itemId,
      input.revision,
      input.text,
      input.decidedBy,
      this.now(),
    );
    if (!item) return err('conflict', CONFLICT_MESSAGE);
    this.audit(
      'edit',
      item,
      input.decidedBy,
      `revision ${input.revision} superseded by ${item.revision}`,
    );
    return ok(item);
  }

  reject(input: RejectInput): OutboxResult<OutboxItem> {
    const guard = this.guard(input.itemId, 'reject');
    if (!guard.ok) return guard;
    if (!this.store.reject(input.itemId, input.reason, this.now())) {
      return err('conflict', CONFLICT_MESSAGE);
    }
    const after = this.reread(input.itemId);
    if (after.ok) this.audit('reject', after.value, input.decidedBy, input.reason);
    return after;
  }

  /**
   * Withdraw an approval before the dispatcher claims it. After the claim the
   * honest answer is "sent — Ethos cannot unsend this"; the conditional UPDATE
   * is what settles which of the two happened.
   */
  revoke(input: DecisionInput): OutboxResult<OutboxItem> {
    const guard = this.guard(input.itemId, 'revoke');
    if (!guard.ok) return guard;
    if (!this.store.revoke(input.itemId, this.now())) {
      return err('conflict', CONFLICT_MESSAGE);
    }
    const after = this.reread(input.itemId);
    if (after.ok) this.audit('revoke', after.value, input.decidedBy, 'approval withdrawn');
    return after;
  }

  /** Re-approve a failed item at the same revision — the human is re-approving
   *  text they already read, so no new revision is written. */
  retry(input: DecisionInput): OutboxResult<OutboxItem> {
    const guard = this.guard(input.itemId, 'retry');
    if (!guard.ok) return guard;
    if (!this.store.retry(input.itemId, input.decidedBy, this.now())) {
      return err('conflict', CONFLICT_MESSAGE);
    }
    const after = this.reread(input.itemId);
    if (after.ok) {
      this.audit(
        'retry',
        after.value,
        input.decidedBy,
        `retrying revision ${after.value.revision}`,
      );
    }
    return after;
  }

  // -- delivery -------------------------------------------------------------

  listClaimable(botKeys: readonly string[]): OutboxItem[] {
    return this.store.listClaimable(botKeys);
  }

  /** Atomically take a row for delivery. `false` means a peer won it, or the
   *  human revoked between the list and the claim. */
  claim(itemId: string): boolean {
    return this.store.claim(itemId, this.now());
  }

  /**
   * Enforcement point 3 of the binding — the dispatcher calls this on a row it
   * has CLAIMED, immediately before handing the text to an adapter.
   *
   * Recomputes the hash from the stored revision over the item's own bound
   * fields. A mismatch means the row and its revision disagree about what was
   * approved — nothing is sent, the item goes to `failed` with "binding
   * mismatch", and a human decides what to do.
   *
   * The two earlier points (the conditional approve, the revision-bumping edit)
   * make this unreachable in normal operation. It is here for everything that
   * is not normal operation: a hand-edited database, a partially applied
   * migration, a restored file. Publishing text to real people on the strength
   * of two guards that both live in the same process is not a trade worth
   * making.
   */
  verifyBinding(itemId: string): OutboxResult<BoundPublication> {
    const item = this.store.get(itemId);
    if (!item) return err('not_found', `no outbox item ${itemId}`);
    if (item.state !== 'sending') {
      return err(
        'illegal_transition',
        `binding can only be verified on a claimed item; ${itemId} is ${item.state}`,
      );
    }
    const revision = this.store.getRevision(itemId, item.revision);
    if (!revision) {
      this.store.markFailed(itemId, 'binding mismatch', this.now());
      return err('binding_mismatch', `revision ${item.revision} of ${itemId} is missing`);
    }
    const recomputed = computeContentHash({
      personalityId: item.personalityId,
      botKey: item.botKey,
      platform: item.platform,
      chatId: item.chatId,
      threadId: item.threadId,
      text: revision.text,
    });
    if (recomputed !== item.contentHash || recomputed !== revision.contentHash) {
      this.store.markFailed(itemId, 'binding mismatch', this.now());
      return err('binding_mismatch', `binding mismatch on ${itemId}; nothing was sent`);
    }
    return ok({ item, revision });
  }

  /** Hand a claimed row back unsent — the pre-send refusal path. The approval
   *  survives, so the item returns to `approved`, not to the human. */
  releaseClaim(itemId: string): OutboxResult<OutboxItem> {
    return this.transition(itemId, 'release', () => this.store.releaseClaim(itemId, this.now()));
  }

  markSent(itemId: string): OutboxResult<OutboxItem> {
    return this.transition(itemId, 'sent', () => this.store.markSent(itemId, this.now()));
  }

  /** The platform did not confirm. The ledger owns every retry from here; the
   *  outbox never resends an item itself. */
  markUnconfirmed(itemId: string, obligationId: string): OutboxResult<OutboxItem> {
    return this.transition(itemId, 'unconfirmed', () =>
      this.store.markUnconfirmed(itemId, obligationId, this.now()),
    );
  }

  markFailed(itemId: string, reason: string): OutboxResult<OutboxItem> {
    return this.transition(itemId, 'fail', () => this.store.markFailed(itemId, reason, this.now()));
  }

  // -- lifecycle maintenance ------------------------------------------------

  /** Run both expiry windows (`PENDING_EXPIRY_MS`, `APPROVAL_VALIDITY_MS` in
   *  `store.ts`). No audit rows: a clock is not a decision. */
  runExpiry(): ExpiryReport {
    const now = this.now();
    return {
      pending: this.store.expirePending(now),
      approvals: this.store.expireApprovals(now),
    };
  }

  /** `awaiting_review` rows whose reviewer never came back (`STALE_THRESHOLD_MS`).
   *  The caller attaches an `unavailable` receipt so the item still reaches the
   *  human. */
  listStaleReviews(): OutboxItem[] {
    return this.store.listStaleReviews(this.now());
  }

  /** `sending` rows claimed by a process that is gone. The caller reconciles
   *  each against the delivery ledger. */
  listStaleSending(): OutboxItem[] {
    return this.store.listStaleSending(this.now());
  }

  close(): void {
    this.store.close();
  }

  // -- internals ------------------------------------------------------------

  /** Refuse a move the lifecycle never admits from the item's current state. */
  private guard<T>(itemId: string, action: OutboxAction): OutboxResult<T> {
    const item = this.store.get(itemId);
    if (!item) return err('not_found', `no outbox item ${itemId}`);
    if (!LEGAL_FROM[action].includes(item.state)) {
      return err(
        'illegal_transition',
        `cannot ${action} an item in state ${item.state} (${itemId})`,
      );
    }
    return ok(undefined as T);
  }

  /** Guard, apply, re-read — the shape every non-audited transition shares. */
  private transition(
    itemId: string,
    action: OutboxAction,
    apply: () => boolean,
  ): OutboxResult<OutboxItem> {
    const guard = this.guard<undefined>(itemId, action);
    if (!guard.ok) return guard;
    if (!apply()) return err('conflict', CONFLICT_MESSAGE);
    return this.reread(itemId);
  }

  private reread(itemId: string): OutboxResult<OutboxItem> {
    const item = this.store.get(itemId);
    return item ? ok(item) : err('not_found', `no outbox item ${itemId}`);
  }

  /**
   * ONE audit row per human decision, written only after the store confirmed
   * the decision landed. Fail-open, like `ApprovalsService.audit`: a broken
   * sink never breaks a decision the human already made.
   */
  private audit(
    decision: OutboxDecision,
    item: OutboxItem,
    decidedBy: string,
    cause: string,
  ): void {
    const obs = this.observability;
    if (!obs) return;
    try {
      obs.recordSafetyApproval({
        decision: AUDIT_DECISION[decision],
        severity: AUDIT_SEVERITY[decision],
        code: OUTBOX_AUDIT_CODES[decision],
        cause: `outbox ${item.id}: ${cause}`,
        details: {
          itemId: item.id,
          personalityId: item.personalityId,
          botKey: item.botKey,
          platform: item.platform,
          chatId: item.chatId,
          ...(item.threadId ? { threadId: item.threadId } : {}),
          revision: item.revision,
          // The hash, never the text: the trail is safe to ship in a support
          // bundle, and the publication's content is not.
          contentHash: item.contentHash,
          state: item.state,
          decidedBy,
        },
      });
    } catch {
      // Audit is fail-open.
    }
  }
}
