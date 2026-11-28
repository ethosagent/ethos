// The token map behind `rca:<token>:<index>` buttons (plan telegram-live-cards D11, D12).
//
// Telegram caps `callback_data` at 64 bytes and a `recommend_actions` prompt may run to 500 chars,
// so a button carries a token and this store holds the prompts. Append-only JSONL at
// `~/.ethos/telegram/<botKey>/card-actions.jsonl`, written through `Storage` and rebuilt on
// `load()` (the `ThreadStateStore` precedent). Records past `CARD_ACTION_TTL_MS` are dropped on
// load, and the file is rewritten once more than half of it is dead.
//
// Without a `Storage` the map is memory-only: every button reads as expired after a restart
// (limitation, D12). Pinned by `__tests__/card-action-store.test.ts`.

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';
import { z } from 'zod';
import { CARD_TOKEN_LENGTH } from '../cards/callback';

/** How long a card's buttons stay live: 48 h. A constant, not config (plan §1 Value). */
export const CARD_ACTION_TTL_MS = 48 * 60 * 60 * 1000;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const ActionSchema = z.object({ label: z.string(), prompt: z.string() });

const PutRecordSchema = z.object({
  type: z.literal('put'),
  token: z.string(),
  chatId: z.string(),
  threadId: z.string().optional(),
  messageId: z.string(),
  question: z.string().optional(),
  actions: z.array(ActionSchema).min(1),
  createdAt: z.number(),
});

const SettleRecordSchema = z.object({
  type: z.literal('settle'),
  token: z.string(),
  index: z.number().int().nonnegative(),
  settledAt: z.number(),
});

const RecordSchema = z.discriminatedUnion('type', [PutRecordSchema, SettleRecordSchema]);

type PutRecord = z.infer<typeof PutRecordSchema>;
type SettleRecord = z.infer<typeof SettleRecordSchema>;

/** What a card is: where it sits and what each button sends. */
export type CardActionRecord = Omit<PutRecord, 'type'>;

export interface CardActionInput {
  chatId: string;
  threadId?: string;
  messageId: string;
  question?: string;
  actions: Array<{ label: string; prompt: string }>;
}

/** The state of a token at tap time. `expired` covers both unknown and past-TTL. */
export type CardTapLookup =
  | { status: 'ok'; record: CardActionRecord }
  | { status: 'settled'; record: CardActionRecord; index: number }
  | { status: 'expired' };

export type CardSettleResult =
  | { status: 'settled'; record: CardActionRecord }
  | { status: 'already'; record: CardActionRecord; index: number }
  | { status: 'invalid' }
  | { status: 'expired' };

interface Entry {
  record: CardActionRecord;
  settledIndex?: number;
  settledAt?: number;
}

export class CardActionStore {
  private readonly file: string;
  private readonly entries = new Map<string, Entry>();
  private loadPromise: Promise<void> | undefined;
  private readonly now: () => number;

  constructor(
    private readonly storage: Storage | undefined,
    private readonly baseDir: string,
    opts: { now?: () => number } = {},
  ) {
    this.file = join(baseDir, 'card-actions.jsonl');
    this.now = opts.now ?? Date.now;
  }

  /** A fresh unguessable token. 10 base32 chars (50 bits); `256 % 32 === 0`, so no modulo bias. */
  newToken(): string {
    return Array.from(randomBytes(CARD_TOKEN_LENGTH), (b) => BASE32[b % 32]).join('');
  }

  /** Rebuild the map from disk, dropping expired records. Idempotent. */
  load(): Promise<void> {
    this.loadPromise ??= this.loadOnce();
    return this.loadPromise;
  }

  private async loadOnce(): Promise<void> {
    if (!this.storage) return;
    const raw = await this.storage.read(this.file);
    if (!raw) return;
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    for (const line of lines) {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        continue; // partial write or manual edit
      }
      const parsed = RecordSchema.safeParse(json);
      if (!parsed.success) continue;
      if (parsed.data.type === 'put') {
        const { type: _type, ...record } = parsed.data;
        if (!this.isExpired(record.createdAt)) this.entries.set(record.token, { record });
      } else {
        const entry = this.entries.get(parsed.data.token);
        if (entry && entry.settledIndex === undefined) {
          entry.settledIndex = parsed.data.index;
          entry.settledAt = parsed.data.settledAt;
        }
      }
    }
    // Rewrite only when over half of the file is dead weight; atomic, so a crash keeps the old file.
    const liveLines = [...this.entries.values()].reduce(
      (n, e) => n + (e.settledIndex === undefined ? 1 : 2),
      0,
    );
    if (liveLines * 2 < lines.length) {
      const body = [...this.entries.values()].flatMap((e) => this.linesFor(e)).join('');
      await this.storage.writeAtomic(this.file, body, { mode: 0o600 });
    }
  }

  /** Remember a posted card. Call after the send succeeded, with the message id it landed as. */
  async put(token: string, input: CardActionInput): Promise<void> {
    await this.load();
    this.dropExpired();
    const record: CardActionRecord = {
      token,
      chatId: input.chatId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      messageId: input.messageId,
      ...(input.question ? { question: input.question } : {}),
      actions: input.actions,
      createdAt: this.now(),
    };
    this.entries.set(token, { record });
    await this.persist(`${JSON.stringify({ type: 'put', ...record } satisfies PutRecord)}\n`);
  }

  /** The state of `token` right now. Synchronous: it reads the map `load()` built. */
  lookup(token: string): CardTapLookup {
    const entry = this.entries.get(token);
    if (!entry || this.isExpired(entry.record.createdAt)) return { status: 'expired' };
    if (entry.settledIndex !== undefined) {
      return { status: 'settled', record: entry.record, index: entry.settledIndex };
    }
    return { status: 'ok', record: entry.record };
  }

  /**
   * Mark button `index` as the card's one choice. The check and the in-memory mark happen before
   * any await, so two taps racing in this process cannot both win (D11); the append follows.
   */
  async settle(token: string, index: number): Promise<CardSettleResult> {
    await this.load();
    const entry = this.entries.get(token);
    if (!entry || this.isExpired(entry.record.createdAt)) return { status: 'expired' };
    if (entry.settledIndex !== undefined) {
      return { status: 'already', record: entry.record, index: entry.settledIndex };
    }
    if (index >= entry.record.actions.length) return { status: 'invalid' };
    entry.settledIndex = index;
    entry.settledAt = this.now();
    const settle: SettleRecord = {
      type: 'settle',
      token,
      index,
      settledAt: entry.settledAt,
    };
    await this.persist(`${JSON.stringify(settle)}\n`);
    return { status: 'settled', record: entry.record };
  }

  private isExpired(createdAt: number): boolean {
    return this.now() - createdAt > CARD_ACTION_TTL_MS;
  }

  private dropExpired(): void {
    for (const [token, entry] of this.entries) {
      if (this.isExpired(entry.record.createdAt)) this.entries.delete(token);
    }
  }

  private linesFor(entry: Entry): string[] {
    const lines = [`${JSON.stringify({ type: 'put', ...entry.record })}\n`];
    if (entry.settledIndex !== undefined) {
      lines.push(
        `${JSON.stringify({
          type: 'settle',
          token: entry.record.token,
          index: entry.settledIndex,
          settledAt: entry.settledAt ?? entry.record.createdAt,
        })}\n`,
      );
    }
    return lines;
  }

  private async persist(line: string): Promise<void> {
    if (!this.storage) return;
    await this.storage.mkdir(this.baseDir);
    await this.storage.append(this.file, line);
  }
}
