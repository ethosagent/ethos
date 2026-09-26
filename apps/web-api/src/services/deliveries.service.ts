import { join } from 'node:path';
import {
  type DeliveryLedger,
  type DeliveryStats,
  SQLiteDeliveryLedger,
} from '@ethosagent/delivery-ledger';
import { type InboundSpool, SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import type { Storage } from '@ethosagent/types';

// Read-only window onto the durable delivery-obligation ledger.
//
// The gateway writes the ledger; this service only reads it, from the SAME file
// (`<ethosDir>/delivery-ledger.db`) the gateway opens in
// apps/ethos/src/commands/gateway.ts. Two processes on one SQLite file is why
// the ledger sets WAL + `busy_timeout`; nothing extra is needed here.
//
// The ledger is a raw-path SQLite store, one of the documented `node:fs`
// carve-outs (see CLAUDE.md, Storage abstraction). `Storage` is still used —
// for the existence probe below, which is a plain read decision and belongs on
// the abstraction.

/** Truncation width for `content` on the wire. See the RPC schema for why. */
const CONTENT_PREVIEW_CHARS = 200;

/** Rows returned when the caller names no limit. */
const DEFAULT_RECENT = 25;

function emptyStats(): DeliveryStats {
  return {
    pending: 0,
    redelivering: 0,
    delivered: 0,
    abandoned: 0,
    voice: { pending: 0, redelivering: 0, delivered: 0, abandoned: 0 },
  };
}

export interface DeliveriesSummaryRow {
  id: string;
  platform: string;
  chatId: string;
  threadId: string | null;
  status: 'pending' | 'redelivering' | 'delivered' | 'abandoned';
  kind: 'text' | 'voice';
  /** The reply text, truncated to {@link CONTENT_PREVIEW_CHARS}. */
  content: string;
  mediaFormat: string | null;
  createdAt: number;
}

export interface DeliveriesSummary {
  stats: DeliveryStats;
  recent: DeliveriesSummaryRow[];
}

export interface DeadInboundRow {
  id: string;
  /** `dead` — given up on. `interrupted` — cut after a tool had started, so
   *  never replayed (plan openclaw-9.5-adoption D5); the chat was asked to
   *  reply `retry`. Both take Replay / Discard. */
  status: 'dead' | 'interrupted';
  platform: string;
  chatId: string;
  threadId: string | null;
  attempts: number;
  lastError: string | null;
  /** Message text, truncated to {@link CONTENT_PREVIEW_CHARS}. */
  text: string;
  receivedAt: number;
  updatedAt: number;
}

/** The text of a spooled payload, or '' when it is unreadable or nulled. */
function payloadText(payload: string): string {
  try {
    const parsed: unknown = JSON.parse(payload);
    const text = (parsed as { text?: unknown } | null)?.text;
    return typeof text === 'string' ? text.slice(0, CONTENT_PREVIEW_CHARS) : '';
  } catch {
    return '';
  }
}

export interface DeliveriesServiceOptions {
  /** Ethos home directory — the ledger sits at `<dataDir>/delivery-ledger.db`. */
  dataDir: string;
  /** Used ONLY to answer "does the ledger file exist yet". */
  storage: Storage;
  /**
   * Open a ledger at `path`. Seam for tests; production is the SQLite one.
   * Called at most once per process (see {@link DeliveriesService.open}).
   */
  openLedger?: (path: string) => DeliveryLedger;
  /** Open the inbound spool at `path`. Seam for tests. */
  openSpool?: (path: string) => InboundSpool;
}

export class DeliveriesService {
  private readonly path: string;
  private ledger: DeliveryLedger | null = null;
  private readonly spoolPath: string;
  private spool: InboundSpool | null = null;

  constructor(private readonly opts: DeliveriesServiceOptions) {
    this.path = join(opts.dataDir, 'delivery-ledger.db');
    this.spoolPath = join(opts.dataDir, 'inbound-spool.db');
  }

  /** Dead-lettered and interrupted inbound messages, newest first, `limit` in
   *  all. Empty — and no file created — while no gateway has ever opened the
   *  spool. */
  async listDeadInbound(limit = 50): Promise<{ rows: DeadInboundRow[] }> {
    const spool = await this.openSpool();
    if (!spool) return { rows: [] };
    const merged = [...spool.listDead(limit), ...spool.listInterrupted(limit)]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
    return {
      rows: merged.map((r) => ({
        id: r.id,
        status: r.status === 'interrupted' ? 'interrupted' : 'dead',
        platform: r.platform,
        chatId: r.chatId,
        threadId: r.threadId ?? null,
        attempts: r.attempts,
        lastError: r.lastError ?? null,
        text: payloadText(r.payload),
        receivedAt: r.receivedAt,
        updatedAt: r.updatedAt,
      })),
    };
  }

  /** A dead or interrupted row back to `received` (attempts reset, tool start
   *  cleared). The running gateway's replay tick picks it up
   *  (`Gateway.replayInboundSpool`, every 60s). */
  async requeueInbound(id: string): Promise<{ ok: boolean }> {
    const spool = await this.openSpool();
    return { ok: spool ? spool.requeue(id) : false };
  }

  /** A dead or interrupted row closed without a turn. */
  async discardInbound(id: string): Promise<{ ok: boolean }> {
    const spool = await this.openSpool();
    return { ok: spool ? spool.discard(id) : false };
  }

  private async openSpool(): Promise<InboundSpool | null> {
    if (this.spool) return this.spool;
    // Same rule as the ledger: a read must not CREATE the database.
    if (!(await this.opts.storage.exists(this.spoolPath))) return null;
    this.spool = (this.opts.openSpool ?? ((p: string) => new SQLiteInboundSpool(p)))(
      this.spoolPath,
    );
    return this.spool;
  }

  async summary(limit = DEFAULT_RECENT): Promise<DeliveriesSummary> {
    const ledger = await this.open();
    // No gateway has ever run here: there are no obligations, and saying so is
    // the honest answer. Opening the ledger anyway would CREATE the file (the
    // constructor mkdirs and migrates), so a deployment that only ever uses the
    // web chat would grow an empty database the first time someone opened a
    // settings page — a write performed by a read, for no information.
    if (!ledger) return { stats: emptyStats(), recent: [] };

    const [stats, recent] = await Promise.all([ledger.stats(), ledger.listRecent(limit)]);
    return {
      stats,
      recent: recent.map((o) => ({
        id: o.id,
        platform: o.platform,
        chatId: o.chatId,
        threadId: o.threadId ?? null,
        status: o.status,
        kind: o.kind,
        content: o.content.slice(0, CONTENT_PREVIEW_CHARS),
        mediaFormat: o.mediaFormat ?? null,
        createdAt: o.createdAt,
      })),
    };
  }

  /**
   * The ledger handle, or null while the file does not exist.
   *
   * Constructed lazily and kept: the gateway holds the same file open, and
   * re-opening a WAL database on every request would churn -wal/-shm handles
   * for nothing. Once opened it is never re-probed — a file cannot un-exist
   * under a live handle, and the probe is only there to avoid creating one.
   */
  /**
   * F06 — close the handle this service opened, if it opened one. Called by
   * `CreateWebApiResult.dispose`: the connection is cached for the life of the
   * process, so without this every run left a -wal/-shm pair behind. A no-op
   * when nothing was opened, and idempotent. Pinned by
   * apps/web-api/src/__tests__/services/read-side-close.test.ts.
   */
  close(): void {
    const ledger = this.ledger as (DeliveryLedger & { close?: () => void }) | null;
    this.ledger = null;
    ledger?.close?.();
    const spool = this.spool;
    this.spool = null;
    spool?.close();
  }

  private async open(): Promise<DeliveryLedger | null> {
    const existing = this.ledger;
    if (existing) return existing;
    if (!(await this.opts.storage.exists(this.path))) return null;
    const opened = (this.opts.openLedger ?? ((p: string) => new SQLiteDeliveryLedger(p)))(
      this.path,
    );
    this.ledger = opened;
    return opened;
  }
}
