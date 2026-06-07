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
        w: { type: 'number', description: 'Grid width in columns (default: 6)' },
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

export function buildDashboardTools(store: DashboardToolStore): Tool[] {
  return [createDashboardCreateTool(store) as Tool, createDashboardAddPanelTool(store) as Tool];
}
