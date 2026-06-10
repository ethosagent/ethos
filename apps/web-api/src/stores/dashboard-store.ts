import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface CreateDashboardParams {
  userId: string;
  title: string;
  description?: string;
  personalityId?: string;
}

export interface AddPanelParams {
  dashboardId: string;
  title?: string;
  blockType: string;
  content: string;
  queryType?: string;
  prompt?: string;
  sqlQuery?: string;
  pluginId?: string;
  dataSourceId?: string;
  cronSchedule?: string;
  col: number;
  row: number;
  w: number;
  h: number;
}

export class DashboardStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  createDashboard(params: CreateDashboardParams): { id: string } {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO dashboards (id, user_id, personality_id, title, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.userId,
        params.personalityId ?? '',
        params.title,
        params.description ?? null,
        now,
        now,
      );
    return { id };
  }

  addPanel(params: AddPanelParams): { id: string } {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO dashboard_panels
       (id, dashboard_id, query_type, block_type, content, title, prompt, sql_query, plugin_id, data_source_id, cron_schedule, col, row, w, h, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.dashboardId,
        params.queryType ?? 'static',
        params.blockType,
        params.content,
        params.title ?? null,
        params.prompt ?? null,
        params.sqlQuery ?? null,
        params.pluginId ?? null,
        params.dataSourceId ?? null,
        params.cronSchedule ?? null,
        params.col,
        params.row,
        params.w,
        params.h,
        now,
        now,
      );
    return { id };
  }

  getNextRow(dashboardId: string): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(MAX(row + h), 0) AS next_row FROM dashboard_panels WHERE dashboard_id = ?',
      )
      .get(dashboardId) as { next_row: number } | undefined;
    return row?.next_row ?? 0;
  }

  verifyOwner(dashboardId: string, userId: string): boolean {
    const row = this.db.prepare('SELECT user_id FROM dashboards WHERE id = ?').get(dashboardId) as
      | { user_id: string }
      | undefined;
    if (!row) return false;
    return row.user_id === userId;
  }

  exists(dashboardId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM dashboards WHERE id = ?').get(dashboardId);
    return row !== undefined;
  }

  updatePanel(
    panelId: string,
    patch: {
      title?: string;
      cronSchedule?: string | null;
      queryType?: string;
      prompt?: string | null;
      sqlQuery?: string | null;
      pluginId?: string | null;
      dataSourceId?: string | null;
      htmlTemplate?: string | null;
    },
  ): void {
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

  listPanels(dashboardId: string): Array<{
    id: string;
    title: string | null;
    blockType: string;
    queryType: string;
    col: number;
    row: number;
    w: number;
    h: number;
  }> {
    const rows = this.db
      .prepare(
        'SELECT id, title, block_type, query_type, col, row, w, h FROM dashboard_panels WHERE dashboard_id = ? ORDER BY row, col',
      )
      .all(dashboardId) as Array<{
      id: string;
      title: string | null;
      block_type: string;
      query_type: string;
      col: number;
      row: number;
      w: number;
      h: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      blockType: r.block_type,
      queryType: r.query_type,
      col: r.col,
      row: r.row,
      w: r.w,
      h: r.h,
    }));
  }

  getPanel(panelId: string): { id: string; col: number; row: number; w: number; h: number } | null {
    const row = this.db
      .prepare('SELECT id, col, row, w, h FROM dashboard_panels WHERE id = ?')
      .get(panelId) as { id: string; col: number; row: number; w: number; h: number } | undefined;
    return row ?? null;
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
}
