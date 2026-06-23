import Database from '@ethosagent/sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { DashboardStore } from '../dashboard-store';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE dashboards (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, personality_id TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE dashboard_panels (
      id TEXT PRIMARY KEY, dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
      query_type TEXT NOT NULL, block_type TEXT NOT NULL, content TEXT NOT NULL,
      metadata TEXT, prompt TEXT, sql_query TEXT, plugin_id TEXT, data_source_id TEXT,
      render_hint TEXT, cron_schedule TEXT, last_run_at INTEGER, last_error TEXT,
      source_conversation_id TEXT, source_message_seq INTEGER, title TEXT,
      col INTEGER NOT NULL DEFAULT 0, row INTEGER NOT NULL DEFAULT 0,
      w INTEGER NOT NULL DEFAULT 6, h INTEGER NOT NULL DEFAULT 4,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
  `);
  return db;
}

describe('DashboardStore', () => {
  let db: Database.Database;
  let store: DashboardStore;

  beforeEach(() => {
    db = createTestDb();
    store = new DashboardStore(db);
  });

  it('creates a dashboard and returns id', () => {
    const { id } = store.createDashboard({ userId: 'u1', title: 'Test' });
    expect(id).toBeTruthy();
  });

  it('verifyOwner returns true for correct user', () => {
    const { id } = store.createDashboard({ userId: 'u1', title: 'Test' });
    expect(store.verifyOwner(id, 'u1')).toBe(true);
    expect(store.verifyOwner(id, 'u2')).toBe(false);
  });

  it('verifyOwner returns false for non-existent dashboard', () => {
    expect(store.verifyOwner('nonexistent', 'u1')).toBe(false);
  });

  it('exists returns true for existing dashboard', () => {
    const { id } = store.createDashboard({ userId: 'u1', title: 'Test' });
    expect(store.exists(id)).toBe(true);
    expect(store.exists('nonexistent')).toBe(false);
  });

  it('adds a panel', () => {
    const { id: dashId } = store.createDashboard({ userId: 'u1', title: 'Test' });
    const { id: panelId } = store.addPanel({
      dashboardId: dashId,
      blockType: 'html',
      content: '<h1>hi</h1>',
      col: 0,
      row: 0,
      w: 12,
      h: 4,
    });
    expect(panelId).toBeTruthy();
  });

  it('getNextRow returns 0 for empty dashboard', () => {
    const { id } = store.createDashboard({ userId: 'u1', title: 'Test' });
    expect(store.getNextRow(id)).toBe(0);
  });

  it('getNextRow returns max(row+h) after panels added', () => {
    const { id } = store.createDashboard({ userId: 'u1', title: 'Test' });
    store.addPanel({
      dashboardId: id,
      blockType: 'html',
      content: 'a',
      col: 0,
      row: 0,
      w: 6,
      h: 4,
    });
    expect(store.getNextRow(id)).toBe(4);
    store.addPanel({
      dashboardId: id,
      blockType: 'html',
      content: 'b',
      col: 0,
      row: 4,
      w: 6,
      h: 8,
    });
    expect(store.getNextRow(id)).toBe(12);
  });

  it('createDashboard defaults personalityId to empty string', () => {
    const { id } = store.createDashboard({ userId: 'u1', title: 'Test' });
    const row = db.prepare('SELECT personality_id FROM dashboards WHERE id = ?').get(id) as {
      personality_id: string;
    };
    expect(row.personality_id).toBe('');
  });

  it('listPanels returns panels ordered by row/col', () => {
    const { id: dashId } = store.createDashboard({ userId: 'u1', title: 'Test' });
    store.addPanel({
      dashboardId: dashId,
      blockType: 'html',
      content: 'a',
      col: 0,
      row: 0,
      w: 12,
      h: 4,
    });
    store.addPanel({
      dashboardId: dashId,
      blockType: 'table',
      content: 'b',
      col: 0,
      row: 4,
      w: 6,
      h: 3,
    });
    const panels = store.listPanels(dashId);
    expect(panels).toHaveLength(2);
    expect(panels[0].w).toBe(12);
    expect(panels[0].blockType).toBe('html');
    expect(panels[1].blockType).toBe('table');
  });

  it('getPanel returns null for nonexistent panel', () => {
    expect(store.getPanel('nonexistent')).toBeNull();
  });

  it('updatePanelLayout changes w and h', () => {
    const { id: dashId } = store.createDashboard({ userId: 'u1', title: 'Test' });
    const { id: panelId } = store.addPanel({
      dashboardId: dashId,
      blockType: 'html',
      content: 'a',
      col: 0,
      row: 0,
      w: 6,
      h: 4,
    });
    store.updatePanelLayout(panelId, { col: 0, row: 0, w: 12, h: 8 });
    const updated = store.getPanel(panelId);
    expect(updated?.w).toBe(12);
    expect(updated?.h).toBe(8);
  });
});
