import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeliveriesService } from '../../services/deliveries.service';

// A real ledger file, not an in-memory one: the "does the file exist yet"
// decision is half of what this service does, and `:memory:` cannot express it.

describe('DeliveriesService', () => {
  let dir: string;
  const storage = new FsStorage();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-deliveries-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns zeros and creates NO database when the gateway has never run', async () => {
    const service = new DeliveriesService({ dataDir: dir, storage });
    const summary = await service.summary();
    expect(summary.recent).toEqual([]);
    expect(summary.stats).toEqual({
      pending: 0,
      redelivering: 0,
      delivered: 0,
      abandoned: 0,
      voice: { pending: 0, redelivering: 0, delivered: 0, abandoned: 0 },
    });
    // The read must not have written: opening SQLiteDeliveryLedger would mkdir
    // and migrate a file this deployment has no use for.
    expect(await storage.exists(join(dir, 'delivery-ledger.db'))).toBe(false);
  });

  it('summarizes a ledger the gateway wrote', async () => {
    const ledger = new SQLiteDeliveryLedger(join(dir, 'delivery-ledger.db'));
    const delivered = await ledger.record({
      botKey: 'bot-a',
      platform: 'telegram',
      chatId: 'chat-1',
      sessionId: 'telegram:bot-a:chat-1',
      content: 'confirmed reply',
    });
    await ledger.markDelivered(delivered);
    await ledger.record({
      botKey: 'bot-a',
      platform: 'slack',
      chatId: 'C123',
      sessionId: 'slack:bot-a:C123',
      threadId: 'thread-7',
      content: 'spoken text',
      kind: 'voice',
      artifactRef: 'artifacts/x.opus',
      mediaFormat: 'opus',
    });
    ledger.close();

    const summary = await new DeliveriesService({ dataDir: dir, storage }).summary();
    expect(summary.stats.delivered).toBe(1);
    expect(summary.stats.pending).toBe(1);
    expect(summary.stats.voice).toEqual({
      pending: 1,
      redelivering: 0,
      delivered: 0,
      abandoned: 0,
    });
    // Newest first — the voice row was recorded last.
    const [first] = summary.recent;
    expect(first?.kind).toBe('voice');
    expect(first?.platform).toBe('slack');
    expect(first?.threadId).toBe('thread-7');
    expect(first?.mediaFormat).toBe('opus');
    expect(first?.status).toBe('pending');
    // A text row carries an explicit null rather than an absent field.
    expect(summary.recent[1]?.threadId).toBeNull();
    expect(summary.recent[1]?.mediaFormat).toBeNull();
  });

  it('truncates content to 200 characters', async () => {
    const ledger = new SQLiteDeliveryLedger(join(dir, 'delivery-ledger.db'));
    await ledger.record({
      botKey: 'bot-a',
      platform: 'telegram',
      chatId: 'chat-1',
      sessionId: 's',
      content: 'x'.repeat(5000),
    });
    ledger.close();

    const summary = await new DeliveriesService({ dataDir: dir, storage }).summary();
    expect(summary.recent[0]?.content).toHaveLength(200);
  });

  it('opens the ledger once and reuses the handle', async () => {
    new SQLiteDeliveryLedger(join(dir, 'delivery-ledger.db')).close();
    let opens = 0;
    const service = new DeliveriesService({
      dataDir: dir,
      storage,
      openLedger: (path) => {
        opens++;
        return new SQLiteDeliveryLedger(path);
      },
    });
    await service.summary();
    await service.summary();
    expect(opens).toBe(1);
  });
});

describe('DeliveriesService — dead inbound (plan reach-and-containment §2.6)', () => {
  let dir: string;
  const storage = new FsStorage();
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-deliveries-inbound-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function deadRow(spool: SQLiteInboundSpool, messageId: string, text: string): string {
    const { id } = spool.accept({
      platform: 'telegram',
      botKey: 'bot-a',
      chatId: 'chat-1',
      messageId,
      laneKey: 'telegram:bot-a:chat-1',
      payload: JSON.stringify({ text }),
    });
    spool.markProcessing(id, 'p');
    spool.markFailed(id, 'tool exploded', 1);
    return id;
  }

  it('lists nothing and creates no database while no gateway has run', async () => {
    const service = new DeliveriesService({ dataDir: dir, storage });
    expect(await service.listDeadInbound()).toEqual({ rows: [] });
    expect(await service.requeueInbound('x')).toEqual({ ok: false });
    expect(await storage.exists(join(dir, 'inbound-spool.db'))).toBe(false);
  });

  it('lists dead rows with truncated text, then requeues and discards them', async () => {
    const spool = new SQLiteInboundSpool(join(dir, 'inbound-spool.db'));
    const a = deadRow(spool, 'a', 'x'.repeat(500));
    const b = deadRow(spool, 'b', 'drop me');
    const service = new DeliveriesService({ dataDir: dir, storage });

    const { rows } = await service.listDeadInbound();
    expect(rows.map((r) => r.id).sort()).toEqual([a, b].sort());
    const rowA = rows.find((r) => r.id === a);
    expect(rowA).toMatchObject({ platform: 'telegram', attempts: 1, lastError: 'tool exploded' });
    expect(rowA?.text).toHaveLength(200);

    expect(await service.requeueInbound(a)).toEqual({ ok: true });
    expect(await service.discardInbound(b)).toEqual({ ok: true });
    // Neither is dead any more.
    expect(await service.requeueInbound(a)).toEqual({ ok: false });
    expect((await service.listDeadInbound()).rows).toEqual([]);
    expect(spool.get(a)).toMatchObject({ status: 'received', attempts: 0 });
    expect(spool.get(b)).toMatchObject({ status: 'done', lastError: 'discarded' });
    service.close();
    spool.close();
  });
});
