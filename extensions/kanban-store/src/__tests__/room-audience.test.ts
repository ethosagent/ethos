// plan personality-memory-boundary D20 — the `room_audience` column, added on
// every open without a `user_version` bump (`addRoomAudienceColumn`).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KanbanStore } from '../index';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kanban-audience-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('kanban room_audience column', () => {
  it('round-trips a stamp; an unstamped task reads with no key', () => {
    const store = new KanbanStore(':memory:');
    const shared = store.createTask({ title: 'a', roomAudience: 'shared' });
    const priv = store.createTask({ title: 'b', roomAudience: 'private' });
    const bare = store.createTask({ title: 'c' });
    expect(store.getTask(shared.id)?.roomAudience).toBe('shared');
    expect(store.getTask(priv.id)?.roomAudience).toBe('private');
    expect(store.getTask(bare.id)).not.toHaveProperty('roomAudience');
    store.close();
  });

  it('an existing board gains the column with its user_version unchanged; old rows are unstamped', () => {
    const path = join(dir, 'board.db');
    const first = new KanbanStore(path);
    const legacy = first.createTask({ title: 'legacy' });
    first.close();
    // Simulate a board written before the column: drop it again.
    const raw = new Database(path);
    raw.exec('ALTER TABLE tasks DROP COLUMN room_audience');
    const before = raw.pragma('user_version') as Array<{ user_version: number }>;
    raw.close();

    const reopened = new KanbanStore(path);
    expect(reopened.getTask(legacy.id)).not.toHaveProperty('roomAudience');
    const fresh = reopened.createTask({ title: 'new', roomAudience: 'shared' });
    expect(reopened.getTask(fresh.id)?.roomAudience).toBe('shared');
    reopened.close();

    const check = new Database(path);
    expect(check.pragma('user_version')).toEqual(before);
    check.close();
  });

  it('a hand-edited value reads as shared (fail closed)', () => {
    const path = join(dir, 'board.db');
    const store = new KanbanStore(path);
    const t = store.createTask({ title: 't' });
    store.close();
    const raw = new Database(path);
    raw.prepare('UPDATE tasks SET room_audience = ? WHERE id = ?').run('bogus', t.id);
    raw.close();
    const reopened = new KanbanStore(path);
    expect(reopened.getTask(t.id)?.roomAudience).toBe('shared');
    reopened.close();
  });
});
