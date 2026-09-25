// U11 (openclaw-9.6-gaps) — the held-notice table: an unprompted channel notice
// waiting out quiet hours or a lane mute. Durable, so a restart inside the
// window does not lose it; released rows are gone.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQLiteNotifyQueue } from '../index';

const notice = {
  botKey: 'bot-a',
  platform: 'telegram',
  chatId: 'C1',
  laneKey: 'telegram:bot-a:C1',
  sessionKey: 'telegram:bot-a:C1',
  text: 'job finished',
};

describe('SQLiteNotifyQueue — held notices', () => {
  it('holds, lists oldest first with its thread, and forgets a released row', async () => {
    const q = new SQLiteNotifyQueue(':memory:');
    await q.hold(notice);
    await q.hold({ ...notice, threadId: 't9', text: 'second' });

    const held = await q.listHeld();
    expect(held.map((n) => n.text)).toEqual(['job finished', 'second']);
    expect(held[0]?.threadId).toBeUndefined();
    expect(held[1]?.threadId).toBe('t9');

    await q.markReleased(held[0]?.id ?? -1);
    expect((await q.listHeld()).map((n) => n.text)).toEqual(['second']);
  });

  it('a held notice survives reopening the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'held-notices-'));
    try {
      const path = join(dir, 'notify-queue.db');
      const first = new SQLiteNotifyQueue(path);
      await first.hold(notice);
      first.close();
      const second = new SQLiteNotifyQueue(path);
      expect((await second.listHeld()).map((n) => n.text)).toEqual(['job finished']);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
