import type { Tool, ToolResult } from '@ethosagent/types';

export interface DashboardToolStore {
  createDashboard(params: {
    userId: string;
    title: string;
    description?: string;
    personalityId?: string;
  }): { id: string };
  addPanel(params: {
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
  }): { id: string };
  getNextRow(dashboardId: string): number;
  verifyOwner(dashboardId: string, userId: string): boolean;
  exists(dashboardId: string): boolean;
  listPanels(dashboardId: string): Array<{
    id: string;
    title: string | null;
    blockType: string;
    queryType: string;
    col: number;
    row: number;
    w: number;
    h: number;
  }>;
  getPanel(panelId: string): { id: string; col: number; row: number; w: number; h: number } | null;
  updatePanelLayout(
    panelId: string,
    layout: { col: number; row: number; w: number; h: number },
  ): void;
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
  ): void;
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
  } | null;
  updateDashboardParams(dashboardId: string, paramsCurrent: Record<string, string>): void;
  updateParamsSchema(
    dashboardId: string,
    paramsSchema: Array<{
      key: string;
      label: string;
      type: string;
      options?: string[];
      default: string;
    }>,
  ): void;
  exportDashboard(dashboardId: string): object | null;
  importDashboard(
    data: Record<string, unknown>,
    userId: string,
    personalityId: string,
  ): { dashboardId: string; warnings: string[] };
}

interface DashboardCreateArgs {
  title: string;
  description?: string;
  personality_id?: string;
}

interface DashboardAddPanelArgs {
  dashboard_id: string;
  title?: string;
  block_type: 'html' | 'image' | 'text' | 'table';
  content: string;
  query_type?: 'static' | 'prompt' | 'sql';
  prompt?: string;
  sql_query?: string;
  plugin_id?: string;
  data_source_id?: string;
  cron_schedule?: string;
  col?: number;
  row?: number;
  w?: number;
  h?: number;
}

export function createDashboardCreateTool(store: DashboardToolStore): Tool<DashboardCreateArgs> {
  return {
    name: 'dashboard_create',
    description:
      'Create a new named dashboard and return its ID and URL. Use this before calling dashboard_add_panel.',
    toolset: 'dashboard',
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Dashboard title' },
        description: { type: 'string', description: 'Optional dashboard description' },
        personality_id: {
          type: 'string',
          description: 'Personality ID for widget execution context',
        },
      },
      required: ['title'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (!args.title) {
        return { ok: false, error: 'title is required', code: 'input_invalid', field: 'title' };
      }
      const userId = (ctx as { userId?: string }).userId ?? 'default-user';
      const result = store.createDashboard({
        userId,
        title: args.title,
        description: args.description,
        personalityId: args.personality_id,
      });
      return {
        ok: true,
        value: `Dashboard created: '${args.title}' (id: ${result.id})\nURL: /dashboards/${result.id}\n\nUse dashboard_add_panel to add panels.`,
      };
    },
  };
}

export function createDashboardAddPanelTool(
  store: DashboardToolStore,
): Tool<DashboardAddPanelArgs> {
  return {
    name: 'dashboard_add_panel',
    description:
      'Add a panel to an existing dashboard with explicit grid coordinates. Supports static HTML/image/text content, prompt-driven widgets, and SQL widgets. Use col/row/w/h to control exact grid placement on the 12-column grid.',
    toolset: 'dashboard',
    maxResultChars: 2000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        dashboard_id: { type: 'string', description: 'Dashboard ID from dashboard_create' },
        title: { type: 'string', description: 'Panel title' },
        block_type: {
          type: 'string',
          enum: ['html', 'image', 'text', 'table'],
          description: 'Content type',
        },
        content: {
          type: 'string',
          description: 'HTML string, image URL, text, or JSON rows',
        },
        query_type: {
          type: 'string',
          enum: ['static', 'prompt', 'sql'],
          description: 'Widget type (default: static)',
        },
        prompt: { type: 'string', description: 'Prompt for prompt-type widgets' },
        sql_query: { type: 'string', description: 'SQL SELECT query for sql-type widgets' },
        plugin_id: { type: 'string', description: 'Plugin ID for sql-type widgets' },
        data_source_id: { type: 'string', description: 'Data source ID for sql-type widgets' },
        cron_schedule: { type: 'string', description: 'Cron expression for auto-refresh' },
        col: { type: 'number', description: 'Grid column (0-11, default: 0)' },
        row: { type: 'number', description: 'Grid row (default: auto — below last panel)' },
        w: {
          type: 'number',
          description: 'Grid width in columns (1-12, default: 12 for full-width)',
        },
        h: { type: 'number', description: 'Grid height in units (default: 4)' },
      },
      required: ['dashboard_id', 'block_type', 'content'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (!args.dashboard_id || !args.block_type || args.content === undefined) {
        return {
          ok: false,
          error: 'dashboard_id, block_type, and content are required',
          code: 'input_invalid',
        };
      }

      const userId = (ctx as { userId?: string }).userId ?? 'default-user';

      if (!store.exists(args.dashboard_id)) {
        return { ok: false, error: 'Dashboard not found', code: 'not_available' };
      }

      if (!store.verifyOwner(args.dashboard_id, userId)) {
        return { ok: false, error: 'Access denied', code: 'execution_failed' };
      }

      const queryType = args.query_type ?? 'static';
      if (queryType === 'sql' && args.sql_query) {
        const trimmed = args.sql_query.trim();
        if (!/^select\b/i.test(trimmed)) {
          return {
            ok: false,
            error: 'Only SELECT queries are allowed',
            code: 'input_invalid',
            field: 'sql_query',
          };
        }
      }

      const col = args.col ?? 0;
      const row = args.row ?? store.getNextRow(args.dashboard_id);
      const w = args.w ?? 6;
      const h = args.h ?? 4;

      const result = store.addPanel({
        dashboardId: args.dashboard_id,
        title: args.title,
        blockType: args.block_type,
        content: args.content,
        queryType,
        prompt: args.prompt,
        sqlQuery: args.sql_query,
        pluginId: args.plugin_id,
        dataSourceId: args.data_source_id,
        cronSchedule: args.cron_schedule,
        col,
        row,
        w,
        h,
      });

      let value = `Panel added: '${args.title ?? 'Untitled'}' (panel_id: ${result.id})\nGrid: col=${col}, row=${row}, w=${w}, h=${h}\nDashboard: /dashboards/${args.dashboard_id}`;

      const contentSize = Math.round(args.content.length / 1024);
      if (contentSize > 200) {
        value += `\n\nNote: panel content is ${contentSize}KB. Consider using query_type: 'sql' for live widgets.`;
      }

      return { ok: true, value };
    },
  };
}

interface DashboardListPanelsArgs {
  dashboard_id: string;
}

export function createDashboardListPanelsTool(
  store: DashboardToolStore,
): Tool<DashboardListPanelsArgs> {
  return {
    name: 'dashboard_list_panels',
    description:
      'List all panels on a dashboard with their IDs, titles, types, and grid positions (col, row, w, h on the 12-column grid). Use this before resizing panels.',
    toolset: 'dashboard',
    maxResultChars: 10_000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        dashboard_id: { type: 'string', description: 'Dashboard ID' },
      },
      required: ['dashboard_id'],
    },
    async execute(args): Promise<ToolResult> {
      if (!args.dashboard_id) {
        return { ok: false, error: 'dashboard_id is required', code: 'input_invalid' };
      }
      const panels = store.listPanels(args.dashboard_id);
      if (panels.length === 0) {
        return { ok: true, value: 'No panels found on this dashboard.' };
      }
      const lines = panels.map(
        (p) =>
          `- ${p.title ?? '(untitled)'} | id: ${p.id} | type: ${p.queryType}/${p.blockType} | grid: col=${p.col} row=${p.row} w=${p.w} h=${p.h}`,
      );
      return { ok: true, value: lines.join('\n') };
    },
  };
}

interface DashboardUpdatePanelLayoutArgs {
  panel_id: string;
  w?: number;
  h?: number;
  col?: number;
  row?: number;
}

export function createDashboardUpdatePanelLayoutTool(
  store: DashboardToolStore,
): Tool<DashboardUpdatePanelLayoutArgs> {
  return {
    name: 'dashboard_update_panel_layout',
    description:
      'Resize or reposition a dashboard panel. Use dashboard_list_panels first to get panel IDs. All layout fields are optional — omitted fields keep their current values.',
    toolset: 'dashboard',
    maxResultChars: 500,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        panel_id: { type: 'string', description: 'Panel ID from dashboard_list_panels' },
        w: { type: 'number', description: 'New width (1-12 columns)' },
        h: { type: 'number', description: 'New height (grid units)' },
        col: { type: 'number', description: 'New column position (0-11)' },
        row: { type: 'number', description: 'New row position' },
      },
      required: ['panel_id'],
    },
    async execute(args): Promise<ToolResult> {
      if (!args.panel_id) {
        return { ok: false, error: 'panel_id is required', code: 'input_invalid' };
      }
      const current = store.getPanel(args.panel_id);
      if (!current) {
        return { ok: false, error: 'Panel not found', code: 'not_available' };
      }
      const col = args.col ?? current.col;
      const row = args.row ?? current.row;
      const w = args.w ?? current.w;
      const h = args.h ?? current.h;
      store.updatePanelLayout(args.panel_id, { col, row, w, h });
      return {
        ok: true,
        value: `Panel updated: col=${col} row=${row} w=${w} h=${h}`,
      };
    },
  };
}

interface DashboardUpdatePanelArgs {
  panel_id: string;
  title?: string;
  query_type?: 'static' | 'prompt' | 'sql' | 'header';
  prompt?: string;
  sql_query?: string;
  plugin_id?: string;
  data_source_id?: string;
  html_template?: string;
  param_defaults?: Record<string, string>;
  emit_config?: Array<{ on: string; param: string; column: string; default: string }>;
  depends_on?: string[];
}

export function createDashboardUpdatePanelTool(
  store: DashboardToolStore,
): Tool<DashboardUpdatePanelArgs> {
  return {
    name: 'dashboard_update_panel',
    description:
      "Update a dashboard panel's query configuration. Use this to convert a static panel to a prompt or SQL widget, or to change an existing panel's prompt/query. Use dashboard_list_panels to get panel IDs first.",
    toolset: 'dashboard',
    maxResultChars: 500,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        panel_id: { type: 'string', description: 'Panel ID from dashboard_list_panels' },
        title: { type: 'string', description: 'New panel title' },
        query_type: {
          type: 'string',
          enum: ['static', 'prompt', 'sql'],
          description: 'Change the panel type',
        },
        prompt: { type: 'string', description: 'Prompt for prompt-type panels' },
        sql_query: { type: 'string', description: 'SELECT query for sql-type panels' },
        plugin_id: { type: 'string', description: 'Plugin ID for sql-type panels' },
        data_source_id: { type: 'string', description: 'Data source ID for sql-type panels' },
        html_template: {
          type: 'string',
          description: 'HTML template with {{column_name}} placeholders, for sql-type panels only',
        },
        param_defaults: {
          type: 'object',
          description: 'Per-param fallback values for this panel.',
          additionalProperties: { type: 'string' },
        },
        emit_config: {
          type: 'array',
          description: 'Rules for what this panel emits on user interaction.',
          items: {
            type: 'object',
            properties: {
              on: { type: 'string', enum: ['rowClick'] },
              param: { type: 'string' },
              column: { type: 'string' },
              default: { type: 'string' },
            },
            required: ['on', 'param', 'column', 'default'],
          },
        },
        depends_on: {
          type: 'array',
          items: { type: 'string' },
          description: 'Panel IDs that must finish refreshing before this panel refreshes.',
        },
      },
      required: ['panel_id'],
    },
    async execute(args): Promise<ToolResult> {
      if (!args.panel_id) {
        return { ok: false, error: 'panel_id is required', code: 'input_invalid' };
      }
      const current = store.getPanel(args.panel_id);
      if (!current) {
        return { ok: false, error: 'Panel not found', code: 'not_available' };
      }
      if (args.query_type === 'sql' && args.sql_query) {
        const trimmed = args.sql_query.trim();
        if (!/^select\b/i.test(trimmed)) {
          return { ok: false, error: 'Only SELECT queries are allowed', code: 'input_invalid' };
        }
      }
      try {
        store.updatePanel(args.panel_id, {
          title: args.title,
          queryType: args.query_type,
          prompt: args.prompt,
          sqlQuery: args.sql_query,
          pluginId: args.plugin_id,
          dataSourceId: args.data_source_id,
          htmlTemplate: args.html_template,
          emitConfig: args.emit_config ?? undefined,
          dependsOn: args.depends_on ?? undefined,
          paramDefaults: args.param_defaults ?? undefined,
        });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Invalid panel update',
          code: 'input_invalid',
          field: 'param_defaults',
        };
      }
      return {
        ok: true,
        value: `Panel ${args.panel_id} updated${args.query_type ? ` → ${args.query_type}` : ''}.`,
      };
    },
  };
}

interface DashboardSetParamsArgs {
  dashboard_id: string;
  params_schema?: Array<{
    key: string;
    label: string;
    type: string;
    options?: string[];
    default: string;
  }>;
  params_current?: Record<string, string>;
}

export function createDashboardSetParamsTool(
  store: DashboardToolStore,
): Tool<DashboardSetParamsArgs> {
  return {
    name: 'dashboard_set_params',
    description:
      'Define or update the parameter schema for a dashboard and optionally set current values.',
    toolset: 'dashboard',
    maxResultChars: 2000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        dashboard_id: { type: 'string', description: 'Dashboard ID' },
        params_schema: {
          type: 'array',
          description: 'Full replacement for the param schema.',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              label: { type: 'string' },
              type: { type: 'string', enum: ['select', 'options', 'date-range'] },
              options: { type: 'array', items: { type: 'string' } },
              default: { type: 'string' },
            },
            required: ['key', 'label', 'type', 'default'],
          },
        },
        params_current: {
          type: 'object',
          description: 'Partial update to current param values.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['dashboard_id'],
    },
    async execute(args): Promise<ToolResult> {
      if (!args.dashboard_id) {
        return { ok: false, error: 'dashboard_id is required', code: 'input_invalid' };
      }
      if (!store.exists(args.dashboard_id)) {
        return { ok: false, error: 'Dashboard not found', code: 'not_available' };
      }
      if (args.params_schema) {
        store.updateParamsSchema(args.dashboard_id, args.params_schema);
      }
      if (args.params_current) {
        try {
          store.updateDashboardParams(args.dashboard_id, args.params_current);
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : 'Invalid dashboard params',
            code: 'input_invalid',
            field: 'params_current',
          };
        }
      }
      return { ok: true, value: 'Dashboard params updated.' };
    },
  };
}

interface DashboardExportArgs {
  dashboard_id: string;
}

export function createDashboardExportTool(store: DashboardToolStore): Tool<DashboardExportArgs> {
  return {
    name: 'dashboard_export',
    description: 'Export a dashboard as a portable JSON string.',
    toolset: 'dashboard',
    maxResultChars: 80_000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        dashboard_id: { type: 'string', description: 'Dashboard ID' },
      },
      required: ['dashboard_id'],
    },
    async execute(args): Promise<ToolResult> {
      if (!args.dashboard_id) {
        return { ok: false, error: 'dashboard_id is required', code: 'input_invalid' };
      }
      const data = store.exportDashboard(args.dashboard_id);
      if (!data) {
        return { ok: false, error: 'Dashboard not found', code: 'not_available' };
      }
      const json = JSON.stringify(data);
      const record = data as Record<string, unknown>;
      const panels = (Array.isArray(record.panels) ? record.panels : []) as unknown[];
      return {
        ok: true,
        value: JSON.stringify({
          json,
          panel_count: panels.length,
          title: record.title ?? '',
          dependencies: Array.isArray(record.dependencies) ? record.dependencies : [],
        }),
      };
    },
  };
}

interface DashboardImportArgs {
  export_json: string;
  title_override?: string;
}

export function createDashboardImportTool(store: DashboardToolStore): Tool<DashboardImportArgs> {
  return {
    name: 'dashboard_import',
    description: 'Create a new dashboard from a previously exported dashboard JSON.',
    toolset: 'dashboard',
    maxResultChars: 2000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        export_json: {
          type: 'string',
          description: 'The JSON string produced by dashboard_export.',
        },
        title_override: {
          type: 'string',
          description: 'Optional new title for the imported dashboard.',
        },
      },
      required: ['export_json'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (!args.export_json) {
        return { ok: false, error: 'export_json is required', code: 'input_invalid' };
      }
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(args.export_json) as Record<string, unknown>;
      } catch {
        return { ok: false, error: 'Invalid JSON', code: 'input_invalid' };
      }
      if (args.title_override) {
        data.title = args.title_override;
      }
      const userId = (ctx as { userId?: string }).userId ?? 'default-user';
      const personalityId = typeof data.personalityId === 'string' ? data.personalityId : 'default';
      let result: { dashboardId: string; warnings: string[] };
      try {
        result = store.importDashboard(data, userId, personalityId);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Invalid dashboard import',
          code: 'input_invalid',
          field: 'export_json',
        };
      }
      let value = `Dashboard imported: '${String(data.title ?? '')}' (id: ${result.dashboardId})\nURL: /dashboards/${result.dashboardId}`;
      if (result.warnings.length > 0) {
        value += `\n\nWarnings:\n${result.warnings.join('\n')}`;
      }
      return { ok: true, value };
    },
  };
}

export function buildDashboardTools(store: DashboardToolStore): Tool[] {
  return [
    createDashboardCreateTool(store) as Tool,
    createDashboardAddPanelTool(store) as Tool,
    createDashboardListPanelsTool(store) as Tool,
    createDashboardUpdatePanelLayoutTool(store) as Tool,
    createDashboardUpdatePanelTool(store) as Tool,
    createDashboardSetParamsTool(store) as Tool,
    createDashboardExportTool(store) as Tool,
    createDashboardImportTool(store) as Tool,
  ];
}
