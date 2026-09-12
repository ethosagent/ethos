import { join } from 'node:path';
import {
  type OutboxItem,
  OutboxService as OutboxLifecycle,
  type OutboxObservability,
  type OutboxResult,
  type OutboxState,
  type OutboxStore,
  SQLiteOutboxStore,
} from '@ethosagent/outbox';
import type { Storage } from '@ethosagent/types';
import type { OutboxItemView, OutboxRevisionView } from '@ethosagent/web-contracts';
import { OutboxStateSchema } from '@ethosagent/web-contracts';

// The web half of the personality approval outbox (plan `trust-before-reach.md`
// Part 2, O-T9).
//
// This service BORROWS a store it does not own, exactly as `DeliveriesService`
// borrows the delivery ledger: the gateway process writes and dispatches
// `<dataDir>/outbox.db`, this one opens the same file to read it and to record
// the human's decisions. Two processes on one SQLite file is why the store sets
// WAL + `busy_timeout`; nothing extra is needed here.
//
// What this service must NEVER do, and the reason it is thin: SEND. web-api
// holds no channel adapters, and a decision is not a delivery. Approving writes
// one row; the gateway's dispatcher — the only process that has adapters —
// claims it and calls `sendTracked`. The boundary is pinned by
// `apps/web-api/src/__tests__/services/outbox-no-adapter.test.ts`, which reads
// this file's own source.
//
// The lifecycle, the conditional UPDATEs and the audit rows all live in
// `@ethosagent/outbox`. Nothing here re-implements a transition or re-checks a
// binding: a second copy of that state machine is how the two drift.

/** Rows returned when the caller names no limit. */
const DEFAULT_LIMIT = 100;

/**
 * Every state an item can be in, derived from the WIRE enum rather than spelled
 * again here — see `OutboxStateSchema`'s doc for the two compile-time checks
 * that keep the wire enum and `@ethosagent/outbox`'s `OutboxState` equal in
 * both directions. This `satisfies` is the first of them.
 */
const ALL_STATES = OutboxStateSchema.options satisfies readonly OutboxState[];

/**
 * What a decision answers with. The shape is `@ethosagent/outbox`'s own result
 * type, re-exported so `rpc/outbox.ts` can map the failure codes onto oRPC
 * errors without importing the extension (`__tests__/layering.test.ts`).
 *
 * `conflict` is the bound-approve refusal — "changed since you viewed it" —
 * and is deliberately distinct from `illegal_transition`, which means the
 * action was never available from that state and a button should not have
 * rendered.
 */
export type OutboxServiceResult<T> = OutboxResult<T>;

export interface OutboxListInput {
  personalityId?: string | undefined;
  teamId?: string | undefined;
  states?: readonly OutboxState[] | undefined;
  limit?: number | undefined;
}

export interface OutboxServiceOptions {
  /** Ethos home directory — the store sits at `<dataDir>/outbox.db`. */
  dataDir: string;
  /** Used ONLY to answer "has a gateway ever queued anything here". */
  storage: Storage;
  /**
   * The safety-audit sink. Passed straight to `OutboxService`, which writes one
   * `recordSafetyApproval` row per human decision (`outbox.approve|reject|edit|
   * revoke|retry`, X-D11). This service writes NO audit rows of its own — a
   * second writer would double every decision in `ethos audit decisions`.
   */
  observability?: OutboxObservability | undefined;
  /** Open a store at `path`. Seam for tests; production is the SQLite one. */
  openStore?: ((path: string) => OutboxStore) | undefined;
  /**
   * The personalities that belong to a team, for the team pane's filter.
   * Borrowed from `TeamsService` at wiring time: team membership is the
   * manifest's business, and re-deriving it here would give the outbox pane a
   * roster the Teams tab could disagree with.
   */
  teamMembers: (teamId: string) => Promise<readonly string[]>;
}

export class OutboxService {
  private readonly path: string;
  private lifecycle: OutboxLifecycle | null = null;

  constructor(private readonly opts: OutboxServiceOptions) {
    this.path = join(opts.dataDir, 'outbox.db');
  }

  async list(input: OutboxListInput = {}): Promise<{ items: OutboxItemView[] }> {
    const lifecycle = await this.open();
    if (!lifecycle) return { items: [] };
    const limit = input.limit ?? DEFAULT_LIMIT;

    const personalities = await this.personalityFilter(input);
    const rows =
      personalities === null
        ? lifecycle.listByState(ALL_STATES, limit)
        : [...personalities].flatMap((id) => lifecycle.listByPersonality(id, limit));

    const states = input.states ? new Set<OutboxState>(input.states) : null;
    const filtered = states ? rows.filter((r) => states.has(r.state)) : rows;
    // Each `listByPersonality` call is ordered on its own, so a multi-personality
    // team read has to be re-ordered before the limit is applied — otherwise the
    // cut would keep the whole first member and drop the rest.
    filtered.sort((a, b) => b.createdAt - a.createdAt);
    return { items: filtered.slice(0, limit).map((item) => this.toView(lifecycle, item)) };
  }

  async get(
    itemId: string,
  ): Promise<OutboxServiceResult<{ item: OutboxItemView; revisions: OutboxRevisionView[] }>> {
    const lifecycle = await this.open();
    if (!lifecycle) return missing(itemId);
    const item = lifecycle.get(itemId);
    if (!item) return missing(itemId);
    return {
      ok: true,
      value: {
        item: this.toView(lifecycle, item),
        revisions: lifecycle.listRevisions(itemId).map(toRevisionView),
      },
    };
  }

  /** Bound approval — the revision and hash the human read travel into the
   *  store's conditional UPDATE. A stale one changes nothing and returns
   *  `conflict`. */
  async approve(input: {
    itemId: string;
    revision: number;
    contentHash: string;
    decidedBy: string;
  }): Promise<OutboxServiceResult<OutboxItemView>> {
    return this.decide(input.itemId, (lifecycle) => lifecycle.approve(input));
  }

  async reject(input: {
    itemId: string;
    reason: string;
    decidedBy: string;
  }): Promise<OutboxServiceResult<OutboxItemView>> {
    return this.decide(input.itemId, (lifecycle) => lifecycle.reject(input));
  }

  async edit(input: {
    itemId: string;
    revision: number;
    text: string;
    decidedBy: string;
  }): Promise<OutboxServiceResult<OutboxItemView>> {
    return this.decide(input.itemId, (lifecycle) => lifecycle.edit(input));
  }

  async revoke(input: {
    itemId: string;
    decidedBy: string;
  }): Promise<OutboxServiceResult<OutboxItemView>> {
    return this.decide(input.itemId, (lifecycle) => lifecycle.revoke(input));
  }

  async retry(input: {
    itemId: string;
    decidedBy: string;
  }): Promise<OutboxServiceResult<OutboxItemView>> {
    return this.decide(input.itemId, (lifecycle) => lifecycle.retry(input));
  }

  /**
   * Close the handle this service opened, if it opened one — called by
   * `CreateWebApiResult.dispose`. A no-op when nothing was opened, and
   * idempotent. Same contract as `DeliveriesService.close`.
   */
  close(): void {
    const lifecycle = this.lifecycle;
    this.lifecycle = null;
    lifecycle?.close();
  }

  // -- internals ------------------------------------------------------------

  private async decide(
    itemId: string,
    apply: (lifecycle: OutboxLifecycle) => OutboxResult<OutboxItem>,
  ): Promise<OutboxServiceResult<OutboxItemView>> {
    const lifecycle = await this.open();
    if (!lifecycle) return missing(itemId);
    const result = apply(lifecycle);
    if (!result.ok) return result;
    return { ok: true, value: this.toView(lifecycle, result.value) };
  }

  /** The personality ids a listing is restricted to, or `null` for no filter. */
  private async personalityFilter(input: OutboxListInput): Promise<Set<string> | null> {
    if (input.teamId === undefined) {
      return input.personalityId === undefined ? null : new Set([input.personalityId]);
    }
    const members = new Set(await this.opts.teamMembers(input.teamId));
    if (input.personalityId === undefined) return members;
    // Both filters: the intersection. A personality that is not on this team's
    // roster matches nothing, rather than quietly winning over the team filter.
    return new Set(members.has(input.personalityId) ? [input.personalityId] : []);
  }

  private toView(lifecycle: OutboxLifecycle, item: OutboxItem): OutboxItemView {
    const revision = lifecycle.getRevision(item.id, item.revision);
    return {
      id: item.id,
      personalityId: item.personalityId,
      botKey: item.botKey,
      platform: item.platform,
      chatId: item.chatId,
      threadId: item.threadId ?? null,
      revision: item.revision,
      contentHash: item.contentHash,
      // A row whose current revision is missing is a corrupt store, not a
      // publication: `OutboxService.verifyBinding` fails it closed before
      // anything is sent. Showing empty text is what stops a human approving a
      // card whose body they cannot see — the hash will not match either way.
      text: revision?.text ?? '',
      state: item.state,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      approverPersonality: item.approverPersonality ?? null,
      review: item.review
        ? {
            verdict: item.review.verdict,
            reasons: item.review.reasons,
            revision: item.review.revision,
            reviewedAt: item.review.reviewedAt,
          }
        : null,
      approvedBy: item.approvedBy ?? null,
      approvedAt: item.approvedAt ?? null,
      approvedRevision: item.approvedRevision ?? null,
      claimedAt: item.claimedAt ?? null,
      sentAt: item.sentAt ?? null,
      obligationId: item.obligationId ?? null,
      failureReason: item.failureReason ?? null,
      rejectionReason: item.rejectionReason ?? null,
      originSessionKey: item.originSessionKey ?? null,
    };
  }

  /**
   * The lifecycle handle, or null while the file does not exist.
   *
   * Lazy and kept, for the reason `DeliveriesService.open` gives: opening the
   * store CREATES and migrates the database, so a deployment that never gated a
   * personality would grow an empty `outbox.db` the first time someone opened a
   * settings page — a write performed by a read, for no information. A decision
   * against a file that does not exist is a decision about an item that cannot
   * exist, and answers `not_found`.
   */
  private async open(): Promise<OutboxLifecycle | null> {
    const existing = this.lifecycle;
    if (existing) return existing;
    if (!(await this.opts.storage.exists(this.path))) return null;
    const store = (this.opts.openStore ?? ((p: string) => new SQLiteOutboxStore(p)))(this.path);
    const opened = new OutboxLifecycle({
      store,
      ...(this.opts.observability ? { observability: this.opts.observability } : {}),
    });
    this.lifecycle = opened;
    return opened;
  }
}

function missing<T>(itemId: string): OutboxServiceResult<T> {
  return { ok: false, code: 'not_found', error: `no outbox item ${itemId}` };
}

function toRevisionView(revision: {
  revision: number;
  text: string;
  contentHash: string;
  author: string;
  createdAt: number;
}): OutboxRevisionView {
  return {
    revision: revision.revision,
    text: revision.text,
    contentHash: revision.contentHash,
    author: revision.author,
    createdAt: revision.createdAt,
  };
}
