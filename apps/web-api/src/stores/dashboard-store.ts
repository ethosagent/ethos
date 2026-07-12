import { randomUUID } from 'node:crypto';
import type Database from '@ethosagent/sqlite';
import { EthosError } from '@ethosagent/types';
import {
  findInvalidParamKeys,
  type ParamDef,
  parseImportPayload,
} from '../services/interpolate-params';

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
      emitConfig?: Array<{ on: string; param: string; column: string; default: string }> | null;
      dependsOn?: string[] | null;
      paramDefaults?: Record<string, string>;
    },
  ): void {
    // Panel `paramDefaults` is a resolution source for interpolateParams, so it
    // is a SQL-injection sink just like dashboard params. Vet it against the
    // owning dashboard's schema before persisting.
    if (patch.paramDefaults !== undefined) {
      this.assertValuesAllowed(this.panelParamsSchema(panelId), patch.paramDefaults);
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
    if (patch.emitConfig !== undefined) {
      sets.push('emit_config = ?');
      params.push(patch.emitConfig ? JSON.stringify(patch.emitConfig) : null);
    }
    if (patch.dependsOn !== undefined) {
      sets.push('depends_on = ?');
      params.push(patch.dependsOn ? JSON.stringify(patch.dependsOn) : null);
    }
    if (patch.paramDefaults !== undefined) {
      sets.push('param_defaults = ?');
      params.push(JSON.stringify(patch.paramDefaults));
    }
    params.push(panelId);
    this.db.prepare(`UPDATE dashboard_panels SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  private parseParamsSchema(raw: string | null): ParamDef[] {
    if (!raw) return [];
    try {
      return JSON.parse(raw) as ParamDef[];
    } catch {
      return [];
    }
  }

  private dashboardParamsSchema(dashboardId: string): ParamDef[] {
    const row = this.db
      .prepare('SELECT params_schema FROM dashboards WHERE id = ?')
      .get(dashboardId) as { params_schema: string | null } | undefined;
    return this.parseParamsSchema(row?.params_schema ?? null);
  }

  private panelParamsSchema(panelId: string): ParamDef[] {
    const row = this.db
      .prepare(
        `SELECT d.params_schema AS params_schema
           FROM dashboard_panels p
           JOIN dashboards d ON d.id = p.dashboard_id
          WHERE p.id = ?`,
      )
      .get(panelId) as { params_schema: string | null } | undefined;
    return this.parseParamsSchema(row?.params_schema ?? null);
  }

  /**
   * Validate a bag of param values against a dashboard's schema before it is
   * stored and later spliced into a SQL/prompt template. This is the same
   * allowlist `DashboardsService.updateDashboardParams` enforces, so the
   * agent-tool store path (params + panel defaults) cannot bypass the
   * SQL-injection defense. Throws `INVALID_INPUT` naming the offending keys.
   */
  private assertValuesAllowed(schema: ParamDef[], values: Record<string, string>): void {
    const invalid = findInvalidParamKeys(schema, values);
    if (invalid.length > 0) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `Dashboard param value(s) not permitted by the parameter schema: ${invalid.join(', ')}`,
        action:
          'Submit only values allowed by each parameter definition (a listed option, or a YYYY-MM-DD date).',
      });
    }
  }

  updateParams(id: string, paramsCurrent: Record<string, string>): void {
    this.assertValuesAllowed(this.dashboardParamsSchema(id), paramsCurrent);
    const now = Date.now();
    this.db
      .prepare('UPDATE dashboards SET params_current = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(paramsCurrent), now, id);
  }

  updatePanelParamDefaults(panelId: string, values: Record<string, string>): void {
    const row = this.db
      .prepare('SELECT param_defaults FROM dashboard_panels WHERE id = ?')
      .get(panelId) as { param_defaults: string | null } | undefined;
    const existing = row?.param_defaults
      ? (JSON.parse(row.param_defaults) as Record<string, string>)
      : {};
    const merged = { ...existing, ...values };
    const now = Date.now();
    this.db
      .prepare('UPDATE dashboard_panels SET param_defaults = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(merged), now, panelId);
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

  getDashboard(dashboardId: string): {
    dashboard: {
      paramsSchema: Array<{
        key: string;
        label: string;
        type: string;
        options?: string[];
        default: string;
      }>;
      paramsCurrent: Record<string, string>;
      cronSchedule: string | null;
    };
    panels: Array<{
      id: string;
      title: string | null;
      pluginId: string | null;
      dataSourceId: string | null;
      emitConfig: Array<{ on: string; param: string; column: string; default: string }> | null;
      dependsOn: string[] | null;
      paramDefaults: Record<string, string>;
      queryType: string;
      blockType: string;
      content: string;
      prompt: string | null;
      sqlQuery: string | null;
      htmlTemplate: string | null;
      cronSchedule: string | null;
      col: number;
      row: number;
      w: number;
      h: number;
    }>;
  } | null {
    const dashRow = this.db.prepare('SELECT * FROM dashboards WHERE id = ?').get(dashboardId) as
      | {
          params_schema: string | null;
          params_current: string | null;
          cron_schedule: string | null;
        }
      | undefined;
    if (!dashRow) return null;

    let paramsSchema: Array<{
      key: string;
      label: string;
      type: string;
      options?: string[];
      default: string;
    }> = [];
    if (dashRow.params_schema) {
      try {
        paramsSchema = JSON.parse(dashRow.params_schema) as typeof paramsSchema;
      } catch {
        paramsSchema = [];
      }
    }
    let paramsCurrent: Record<string, string> = {};
    if (dashRow.params_current) {
      try {
        paramsCurrent = JSON.parse(dashRow.params_current) as Record<string, string>;
      } catch {
        paramsCurrent = {};
      }
    }

    const panelRows = this.db
      .prepare('SELECT * FROM dashboard_panels WHERE dashboard_id = ? ORDER BY row, col')
      .all(dashboardId) as Array<{
      id: string;
      title: string | null;
      plugin_id: string | null;
      data_source_id: string | null;
      emit_config: string | null;
      depends_on: string | null;
      param_defaults: string | null;
      query_type: string;
      block_type: string;
      content: string;
      prompt: string | null;
      sql_query: string | null;
      html_template: string | null;
      cron_schedule: string | null;
      col: number;
      row: number;
      w: number;
      h: number;
    }>;

    const panels = panelRows.map((r) => {
      let emitConfig: Array<{
        on: string;
        param: string;
        column: string;
        default: string;
      }> | null = null;
      if (r.emit_config) {
        try {
          emitConfig = JSON.parse(r.emit_config) as typeof emitConfig;
        } catch {
          emitConfig = null;
        }
      }
      let dependsOn: string[] | null = null;
      if (r.depends_on) {
        try {
          dependsOn = JSON.parse(r.depends_on) as string[];
        } catch {
          dependsOn = null;
        }
      }
      let paramDefaults: Record<string, string> = {};
      if (r.param_defaults) {
        try {
          paramDefaults = JSON.parse(r.param_defaults) as Record<string, string>;
        } catch {
          paramDefaults = {};
        }
      }
      return {
        id: r.id,
        title: r.title,
        pluginId: r.plugin_id,
        dataSourceId: r.data_source_id,
        emitConfig,
        dependsOn,
        paramDefaults,
        queryType: r.query_type,
        blockType: r.block_type,
        content: r.content,
        prompt: r.prompt,
        sqlQuery: r.sql_query,
        htmlTemplate: r.html_template,
        cronSchedule: r.cron_schedule,
        col: r.col,
        row: r.row,
        w: r.w,
        h: r.h,
      };
    });

    return {
      dashboard: { paramsSchema, paramsCurrent, cronSchedule: dashRow.cron_schedule },
      panels,
    };
  }

  updateDashboardParams(dashboardId: string, paramsCurrent: Record<string, string>): void {
    this.assertValuesAllowed(this.dashboardParamsSchema(dashboardId), paramsCurrent);
    const now = Date.now();
    this.db
      .prepare('UPDATE dashboards SET params_current = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(paramsCurrent), now, dashboardId);
  }

  updateParamsSchema(
    dashboardId: string,
    paramsSchema: Array<{
      key: string;
      label: string;
      type: string;
      options?: string[];
      default: string;
    }>,
  ): void {
    const now = Date.now();
    this.db
      .prepare('UPDATE dashboards SET params_schema = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(paramsSchema), now, dashboardId);
  }

  exportDashboard(dashboardId: string): object | null {
    const result = this.getDashboard(dashboardId);
    if (!result) return null;
    const { dashboard, panels } = result;

    const depMap = new Map<string, { pluginId: string; dataSourceId: string; titles: string[] }>();
    for (const p of panels) {
      if (p.pluginId && p.dataSourceId) {
        const key = `${p.pluginId}:${p.dataSourceId}`;
        const entry = depMap.get(key);
        if (entry) {
          entry.titles.push(p.title ?? '(untitled)');
        } else {
          depMap.set(key, {
            pluginId: p.pluginId,
            dataSourceId: p.dataSourceId,
            titles: [p.title ?? '(untitled)'],
          });
        }
      }
    }

    const dependencies = [...depMap.values()].map((d) => ({
      type: 'plugin' as const,
      pluginId: d.pluginId,
      dataSourceId: d.dataSourceId,
      requiredBy: d.titles,
    }));

    const idToIndex = new Map(panels.map((p, i) => [p.id, i]));

    const exportPanels = panels.map((p) => ({
      title: p.title,
      queryType: p.queryType,
      blockType: p.blockType,
      content: p.content,
      prompt: p.prompt,
      sqlQuery: p.sqlQuery,
      pluginId: p.pluginId,
      dataSourceId: p.dataSourceId,
      cronSchedule: p.cronSchedule,
      htmlTemplate: p.htmlTemplate,
      emitConfig: p.emitConfig,
      dependsOnIndices: (p.dependsOn ?? [])
        .map((depId) => idToIndex.get(depId) ?? -1)
        .filter((i) => i >= 0),
      paramDefaults: p.paramDefaults,
      col: p.col,
      row: p.row,
      w: p.w,
      h: p.h,
    }));

    return {
      version: 1,
      title: '',
      dependencies,
      paramsSchema: dashboard.paramsSchema,
      paramsCurrent: dashboard.paramsCurrent,
      cronSchedule: dashboard.cronSchedule,
      panels: exportPanels,
    };
  }

  importDashboard(
    data: Record<string, unknown>,
    userId: string,
    personalityId: string,
  ): { dashboardId: string; warnings: string[] } {
    // Vet the untrusted payload before any value reaches a SQL sink: structural
    // safeParse, SELECT-only guard per panel query, and the param allowlist on
    // paramsCurrent + each panel's paramDefaults. Throws INVALID_INPUT on any
    // violation — the calling tool surfaces it.
    const validated = parseImportPayload(data);
    const now = Date.now();
    const dashId = randomUUID();

    this.db
      .prepare(
        `INSERT INTO dashboards (id, user_id, personality_id, title, description, params_schema, params_current, cron_schedule, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        dashId,
        userId,
        personalityId,
        validated.title ?? 'Imported Dashboard',
        null,
        validated.paramsSchema ? JSON.stringify(validated.paramsSchema) : null,
        validated.paramsCurrent ? JSON.stringify(validated.paramsCurrent) : null,
        validated.cronSchedule ?? null,
        now,
        now,
      );

    const panels = validated.panels ?? [];
    const newPanelIds: string[] = [];
    for (const panel of panels) {
      const panelId = randomUUID();
      newPanelIds.push(panelId);
      this.db
        .prepare(
          `INSERT INTO dashboard_panels
           (id, dashboard_id, query_type, block_type, content, prompt, sql_query,
            plugin_id, data_source_id, cron_schedule, html_template, title,
            emit_config, param_defaults,
            col, row, w, h, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          panelId,
          dashId,
          panel.queryType ?? 'static',
          panel.blockType ?? 'html',
          panel.content ?? '',
          panel.prompt ?? null,
          panel.sqlQuery ?? null,
          panel.pluginId ?? null,
          panel.dataSourceId ?? null,
          panel.cronSchedule ?? null,
          panel.htmlTemplate ?? null,
          panel.title ?? null,
          panel.emitConfig ? JSON.stringify(panel.emitConfig) : null,
          panel.paramDefaults ? JSON.stringify(panel.paramDefaults) : null,
          panel.col ?? 0,
          panel.row ?? 0,
          panel.w ?? 6,
          panel.h ?? 4,
          now,
          now,
        );
    }

    // Remap dependsOnIndices to new panel UUIDs
    for (let i = 0; i < panels.length; i++) {
      const indices = panels[i]?.dependsOnIndices ?? [];
      if (indices.length > 0) {
        const depIds = indices
          .map((idx) => newPanelIds[idx])
          .filter((id): id is string => id !== undefined);
        if (depIds.length > 0) {
          const pid = newPanelIds[i];
          if (pid) {
            this.db
              .prepare('UPDATE dashboard_panels SET depends_on = ? WHERE id = ?')
              .run(JSON.stringify(depIds), pid);
          }
        }
      }
    }

    const warnings: string[] = [];
    return { dashboardId: dashId, warnings };
  }
}
