// `ethos doctor` — the "Inbound spool" block (plan reach-and-containment §2.6).

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkInboundSpool, describeInboundSpool } from '../doctor';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'doctor-spool-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(botKey: string, messageId: string): { spool: SQLiteInboundSpool; id: string } {
  const spool = new SQLiteInboundSpool(join(dir, 'inbound-spool.db'));
  const { id } = spool.accept({
    platform: 'telegram',
    botKey,
    chatId: 'chat-9',
    messageId,
    laneKey: `telegram:${botKey}:chat-9`,
    payload: '{}',
  });
  return { spool, id };
}

describe('doctor — inbound spool block', () => {
  it('reports absent without creating the database', async () => {
    const report = await checkInboundSpool(dir, ['bot-a']);
    expect(report.status).toBe('absent');
    expect(existsSync(join(dir, 'inbound-spool.db'))).toBe(false);
    expect(describeInboundSpool(report)[0]).toContain('No inbound spool yet');
  });

  it('renders counts, dead rows with the remediation commands, and orphans', async () => {
    const dead = seed('bot-a', 'poison');
    dead.spool.markProcessing(dead.id, 'p');
    dead.spool.markFailed(dead.id, 'tool exploded', 1);
    dead.spool.close();
    const orphan = seed('bot-gone', 'owed');
    orphan.spool.close();

    const report = await checkInboundSpool(dir, ['bot-a'], Date.now() + 5 * 60_000);
    expect(report.counts).toMatchObject({ received: 1, dead: 1 });
    expect(report.orphaned?.map((o) => o.id)).toEqual([orphan.id]);
    const text = describeInboundSpool(report).join('\n');
    expect(text).toContain('1 owed · 0 in progress · 0 done · 1 dead');
    expect(text).toContain(`${dead.id}  telegram:chat-9  attempts 1  tool exploded`);
    expect(text).toContain('ethos gateway spool replay <id>');
    expect(text).toContain('ethos gateway spool discard <id>');
    expect(text).toContain('for a bot no longer configured');
    expect(text).toContain(`${orphan.id}  telegram:chat-9  bot bot-gone`);
    expect(text).toContain('oldest owed message: 5 min old');
  });

  it('renders interrupted rows (plan openclaw-9.5-adoption D5) apart from dead ones', async () => {
    const cut = seed('bot-a', 'paid-half');
    cut.spool.markProcessing(cut.id, 'p');
    cut.spool.markToolStarted(cut.id);
    cut.spool.markInterrupted(cut.id, 'interrupted after a tool started');
    cut.spool.close();

    const report = await checkInboundSpool(dir, ['bot-a']);
    expect(report.counts).toMatchObject({ interrupted: 1, dead: 0 });
    expect(report.interrupted?.map((r) => r.id)).toEqual([cut.id]);
    const text = describeInboundSpool(report).join('\n');
    expect(text).toContain('0 dead · 1 interrupted');
    expect(text).toContain('1 interrupted message(s)');
    expect(text).toContain(`${cut.id}  telegram:chat-9  interrupted after a tool started`);
    expect(text).toContain('Re-run anyway with: ethos gateway spool replay <id>');
    expect(text).not.toContain('dead letter(s)');
  });

  it('lists up to 10 dead rows, then a count', async () => {
    for (let i = 0; i < 12; i++) {
      const r = seed('bot-a', `m-${i}`);
      r.spool.markDead(r.id, 'stale');
      r.spool.close();
    }
    const text = describeInboundSpool(await checkInboundSpool(dir, ['bot-a'])).join('\n');
    expect(text).toContain('12 dead letter(s)');
    expect(text).toContain('… and 2 more');
  });

  it('says orphans are unknown when the configured bots cannot be read', async () => {
    seed('bot-a', 'x').spool.close();
    const text = describeInboundSpool(await checkInboundSpool(dir, null)).join('\n');
    expect(text).toContain('orphaned rows: unknown');
  });
});
