import { randomUUID } from 'node:crypto';
import type { WidgetTemplate } from '@ethosagent/types';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Dashboard {
  id: string;
  userId: string;
  personalityId: string;
  title: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DashboardPanel {
  id: string;
  dashboardId: string;
  queryType: 'static' | 'prompt' | 'sql';
  blockType: 'html' | 'image' | 'pdf' | 'text' | 'table';
  content: string;
  metadata: Record<string, unknown> | null;
  title: string | null;
  prompt: string | null;
  sqlQuery: string | null;
  pluginId: string | null;
  dataSourceId: string | null;
  renderHint: string | null;
  cronSchedule: string | null;
  htmlTemplate: string | null;
  lastRunAt: number | null;
  lastError: string | null;
  sourceConversationId: string | null;
  sourceMessageSeq: number | null;
  col: number;
  row: number;
  w: number;
  h: number;
  createdAt: number;
  updatedAt: number;
}

export interface AddPanelInput {
  queryType: 'static' | 'prompt' | 'sql';
  blockType: 'html' | 'image' | 'pdf' | 'text' | 'table';
  content: string;
  metadata?: Record<string, unknown>;
  title?: string;
  prompt?: string;
  sqlQuery?: string;
  pluginId?: string;
  dataSourceId?: string;
  renderHint?: string;
  cronSchedule?: string;
  htmlTemplate?: string;
  sourceConversationId?: string;
  sourceMessageSeq?: number;
}

export interface DashboardsServiceOptions {
  dbPath: string;
}

// ---------------------------------------------------------------------------
// Default grid sizes by block type
// ---------------------------------------------------------------------------

const DEFAULT_SIZES: Record<string, { w: number; h: number }> = {
  table: { w: 6, h: 4 },
  html: { w: 6, h: 5 },
  image: { w: 4, h: 4 },
  text: { w: 4, h: 3 },
  pdf: { w: 6, h: 6 },
};

const GRID_COLS = 12;

// ---------------------------------------------------------------------------
// Row helpers — map between snake_case DB rows and camelCase TS types
// ---------------------------------------------------------------------------

interface DashboardRow {
  id: string;
  user_id: string;
  personality_id: string;
  title: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

interface PanelRow {
  id: string;
  dashboard_id: string;
  query_type: string;
  block_type: string;
  content: string;
  metadata: string | null;
  title: string | null;
  prompt: string | null;
  sql_query: string | null;
  plugin_id: string | null;
  data_source_id: string | null;
  render_hint: string | null;
  cron_schedule: string | null;
  html_template: string | null;
  last_run_at: number | null;
  last_error: string | null;
  source_conversation_id: string | null;
  source_message_seq: number | null;
  col: number;
  row: number;
  w: number;
  h: number;
  created_at: number;
  updated_at: number;
}

function toDashboard(row: DashboardRow): Dashboard {
  return {
    id: row.id,
    userId: row.user_id,
    personalityId: row.personality_id,
    title: row.title,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPanel(row: PanelRow): DashboardPanel {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  return {
    id: row.id,
    dashboardId: row.dashboard_id,
    queryType: row.query_type as DashboardPanel['queryType'],
    blockType: row.block_type as DashboardPanel['blockType'],
    content: row.content,
    metadata,
    title: row.title,
    prompt: row.prompt,
    sqlQuery: row.sql_query,
    pluginId: row.plugin_id,
    dataSourceId: row.data_source_id,
    renderHint: row.render_hint,
    cronSchedule: row.cron_schedule,
    htmlTemplate: row.html_template,
    lastRunAt: row.last_run_at,
    lastError: row.last_error,
    sourceConversationId: row.source_conversation_id,
    sourceMessageSeq: row.source_message_seq,
    col: row.col,
    row: row.row,
    w: row.w,
    h: row.h,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DashboardsService {
  private readonly db: Database.Database;

  constructor(opts: DashboardsServiceOptions) {
    this.db = new Database(opts.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.createTables();
  }

  /** Expose the underlying DB handle so callers (e.g. DashboardStore) can
   *  share a single connection instead of opening a duplicate. */
  getDb(): Database.Database {
    return this.db;
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dashboards (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL,
        personality_id TEXT NOT NULL,
        title          TEXT NOT NULL,
        description    TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS dashboard_panels (
        id                     TEXT PRIMARY KEY,
        dashboard_id           TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        query_type             TEXT NOT NULL CHECK(query_type IN ('static','prompt','sql')),
        block_type             TEXT NOT NULL CHECK(block_type IN ('html','image','pdf','text','table')),
        content                TEXT NOT NULL,
        metadata               TEXT,
        prompt                 TEXT,
        sql_query              TEXT,
        plugin_id              TEXT,
        data_source_id         TEXT,
        render_hint            TEXT,
        cron_schedule          TEXT,
        html_template          TEXT,
        last_run_at            INTEGER,
        last_error             TEXT,
        source_conversation_id TEXT,
        source_message_seq     INTEGER,
        title                  TEXT,
        col                    INTEGER NOT NULL DEFAULT 0,
        row                    INTEGER NOT NULL DEFAULT 0,
        w                      INTEGER NOT NULL DEFAULT 6,
        h                      INTEGER NOT NULL DEFAULT 4,
        created_at             INTEGER NOT NULL,
        updated_at             INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_dashboard_panels_dashboard
        ON dashboard_panels(dashboard_id, row, col);
    `);
    const panelCols = this.db.prepare('PRAGMA table_info(dashboard_panels)').all() as {
      name: string;
    }[];
    if (!panelCols.some((c) => c.name === 'html_template')) {
      this.db.exec('ALTER TABLE dashboard_panels ADD COLUMN html_template TEXT');
    }
  }

  // -------------------------------------------------------------------------
  // Dashboard CRUD
  // -------------------------------------------------------------------------

  create(userId: string, title: string, personalityId: string, description?: string): Dashboard {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO dashboards (id, user_id, personality_id, title, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, personalityId, title, description ?? null, now, now);
    return {
      id,
      userId,
      personalityId,
      title,
      description: description ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  list(userId: string): Dashboard[] {
    const rows = this.db
      .prepare('SELECT * FROM dashboards WHERE user_id = ? ORDER BY updated_at DESC')
      .all(userId) as DashboardRow[];
    return rows.map(toDashboard);
  }

  get(id: string): { dashboard: Dashboard; panels: DashboardPanel[] } | null {
    const row = this.db.prepare('SELECT * FROM dashboards WHERE id = ?').get(id) as
      | DashboardRow
      | undefined;
    if (!row) return null;
    const panelRows = this.db
      .prepare('SELECT * FROM dashboard_panels WHERE dashboard_id = ? ORDER BY row, col')
      .all(id) as PanelRow[];
    return { dashboard: toDashboard(row), panels: panelRows.map(toPanel) };
  }

  update(id: string, patch: { title?: string; description?: string }): void {
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(patch.title);
    }
    if (patch.description !== undefined) {
      sets.push('description = ?');
      params.push(patch.description);
    }
    params.push(id);
    this.db.prepare(`UPDATE dashboards SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM dashboards WHERE id = ?').run(id);
  }

  // -------------------------------------------------------------------------
  // Panel CRUD
  // -------------------------------------------------------------------------

  addPanel(dashboardId: string, panel: AddPanelInput): DashboardPanel {
    // SQL validation
    if (panel.queryType === 'sql') {
      if (!panel.sqlQuery) {
        throw new Error('sqlQuery is required for sql query type');
      }
      const trimmed = panel.sqlQuery.trim();
      if (!/^select\b/i.test(trimmed)) {
        throw new Error('SQL query must start with SELECT');
      }
      // Must not contain ';' except as optional trailing character
      const withoutTrailingSemicolon = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed;
      if (withoutTrailingSemicolon.includes(';')) {
        throw new Error('SQL query must not contain multiple statements');
      }
    }

    const defaults = DEFAULT_SIZES[panel.blockType] ?? { w: 6, h: 4 };
    const { col, row } = this.nextGridPosition(dashboardId, defaults.w);
    const now = Date.now();
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO dashboard_panels
         (id, dashboard_id, query_type, block_type, content, metadata, prompt, sql_query,
          plugin_id, data_source_id, render_hint, cron_schedule, html_template, source_conversation_id,
          source_message_seq, title, col, row, w, h, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        dashboardId,
        panel.queryType,
        panel.blockType,
        panel.content,
        panel.metadata ? JSON.stringify(panel.metadata) : null,
        panel.prompt ?? null,
        panel.sqlQuery ?? null,
        panel.pluginId ?? null,
        panel.dataSourceId ?? null,
        panel.renderHint ?? null,
        panel.cronSchedule ?? null,
        panel.htmlTemplate ?? null,
        panel.sourceConversationId ?? null,
        panel.sourceMessageSeq ?? null,
        panel.title ?? null,
        col,
        row,
        defaults.w,
        defaults.h,
        now,
        now,
      );

    return {
      id,
      dashboardId,
      queryType: panel.queryType,
      blockType: panel.blockType,
      content: panel.content,
      metadata: panel.metadata ?? null,
      title: panel.title ?? null,
      prompt: panel.prompt ?? null,
      sqlQuery: panel.sqlQuery ?? null,
      pluginId: panel.pluginId ?? null,
      dataSourceId: panel.dataSourceId ?? null,
      renderHint: panel.renderHint ?? null,
      cronSchedule: panel.cronSchedule ?? null,
      htmlTemplate: panel.htmlTemplate ?? null,
      lastRunAt: null,
      lastError: null,
      sourceConversationId: panel.sourceConversationId ?? null,
      sourceMessageSeq: panel.sourceMessageSeq ?? null,
      col,
      row,
      w: defaults.w,
      h: defaults.h,
      createdAt: now,
      updatedAt: now,
    };
  }

  updatePanel(
    panelId: string,
    patch: {
      title?: string;
      cronSchedule?: string | null;
      queryType?: 'static' | 'prompt' | 'sql';
      prompt?: string | null;
      sqlQuery?: string | null;
      pluginId?: string | null;
      dataSourceId?: string | null;
      htmlTemplate?: string | null;
    },
  ): void {
    if (patch.queryType === 'sql' && patch.sqlQuery) {
      const trimmed = patch.sqlQuery.trim();
      if (!/^select\b/i.test(trimmed)) {
        throw new Error('SQL query must start with SELECT');
      }
      const withoutTrailing = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed;
      if (withoutTrailing.includes(';')) {
        throw new Error('SQL query must not contain multiple statements');
      }
    }
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(patch.title);
    }
    if (patch.cronSchedule !== undefined) {
      sets.push('cron_schedule = ?');
      params.push(patch.cronSchedule);
    }
    if (patch.queryType !== undefined) {
      sets.push('query_type = ?');
      params.push(patch.queryType);
    }
    if (patch.prompt !== undefined) {
      sets.push('prompt = ?');
      params.push(patch.prompt);
    }
    if (patch.sqlQuery !== undefined) {
      sets.push('sql_query = ?');
      params.push(patch.sqlQuery);
    }
    if (patch.pluginId !== undefined) {
      sets.push('plugin_id = ?');
      params.push(patch.pluginId);
    }
    if (patch.dataSourceId !== undefined) {
      sets.push('data_source_id = ?');
      params.push(patch.dataSourceId);
    }
    if (patch.htmlTemplate !== undefined) {
      sets.push('html_template = ?');
      params.push(patch.htmlTemplate);
    }
    params.push(panelId);
    this.db.prepare(`UPDATE dashboard_panels SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  updatePanelLayout(
    panelId: string,
    layout: { col: number; row: number; w: number; h: number },
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE dashboard_panels SET col = ?, row = ?, w = ?, h = ?, updated_at = ? WHERE id = ?',
      )
      .run(layout.col, layout.row, layout.w, layout.h, now, panelId);
  }

  updatePanelContent(panelId: string, content: string, blockType?: string): void {
    const now = Date.now();
    if (blockType) {
      this.db
        .prepare(
          'UPDATE dashboard_panels SET content = ?, block_type = ?, updated_at = ? WHERE id = ?',
        )
        .run(content, blockType, now, panelId);
    } else {
      this.db
        .prepare('UPDATE dashboard_panels SET content = ?, updated_at = ? WHERE id = ?')
        .run(content, now, panelId);
    }
  }

  setPanelError(panelId: string, error: string): void {
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE dashboard_panels SET last_error = ?, last_run_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(error, now, now, panelId);
  }

  clearPanelError(panelId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE dashboard_panels SET last_error = NULL, last_run_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(now, now, panelId);
  }

  deletePanel(panelId: string): void {
    this.db.prepare('DELETE FROM dashboard_panels WHERE id = ?').run(panelId);
  }

  getPanel(panelId: string): DashboardPanel | null {
    const row = this.db.prepare('SELECT * FROM dashboard_panels WHERE id = ?').get(panelId) as
      | PanelRow
      | undefined;
    return row ? toPanel(row) : null;
  }

  listLivePanels(dashboardId: string): DashboardPanel[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM dashboard_panels WHERE dashboard_id = ? AND query_type != 'static' ORDER BY row, col",
      )
      .all(dashboardId) as PanelRow[];
    return rows.map(toPanel);
  }

  // -------------------------------------------------------------------------
  // Widget templates — delegates to plugin loader (stub for now)
  // -------------------------------------------------------------------------

  async listWidgetTemplates(): Promise<WidgetTemplate[]> {
    return [];
  }

  // -------------------------------------------------------------------------
  // Grid placement
  // -------------------------------------------------------------------------

  private nextGridPosition(dashboardId: string, panelWidth: number): { col: number; row: number } {
    const rows = this.db
      .prepare(
        'SELECT col, row, w, h FROM dashboard_panels WHERE dashboard_id = ? ORDER BY row DESC, col DESC',
      )
      .all(dashboardId) as Array<{ col: number; row: number; w: number; h: number }>;

    if (rows.length === 0) {
      return { col: 0, row: 0 };
    }

    // Find the maximum row bottom
    let maxRowBottom = 0;
    for (const r of rows) {
      const bottom = r.row + r.h;
      if (bottom > maxRowBottom) maxRowBottom = bottom;
    }

    // Build an occupancy set for quick lookup
    const occupied = new Set<string>();
    for (const r of rows) {
      for (let c = r.col; c < r.col + r.w; c++) {
        for (let ry = r.row; ry < r.row + r.h; ry++) {
          occupied.add(`${c},${ry}`);
        }
      }
    }

    // Scan row by row, left to right, looking for space
    for (let ry = 0; ry <= maxRowBottom; ry++) {
      for (let c = 0; c <= GRID_COLS - panelWidth; c++) {
        let fits = true;
        for (let dc = 0; dc < panelWidth; dc++) {
          if (occupied.has(`${c + dc},${ry}`)) {
            fits = false;
            break;
          }
        }
        if (fits) return { col: c, row: ry };
      }
    }

    // No space found in existing rows — place on the next row
    return { col: 0, row: maxRowBottom };
  }
}
