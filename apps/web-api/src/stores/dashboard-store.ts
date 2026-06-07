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
}
