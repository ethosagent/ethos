import type { Tool, ToolResult } from '@ethosagent/types';

interface DashboardSaveArgs {
  block_type: 'html' | 'image' | 'text';
  content: string;
  metadata?: Record<string, unknown>;
  dashboard_title: string;
  panel_title?: string;
}

export const dashboardSaveTool: Tool<DashboardSaveArgs> = {
  name: 'dashboard_save',
  description:
    'Save a rendered block to a persistent dashboard. Call after render_html/render_image when the user wants to pin output to a dashboard. Pass block_type and content directly — both are required.',
  toolset: 'ui',
  alwaysInclude: true,
  capabilities: {},
  schema: {
    type: 'object',
    properties: {
      block_type: {
        type: 'string',
        enum: ['html', 'image', 'text'],
        description: 'Block type of the content being saved',
      },
      content: { type: 'string', description: 'The rendered content to save' },
      metadata: {
        type: 'object',
        description: 'Optional panel metadata (title, alt text, etc.)',
      },
      dashboard_title: {
        type: 'string',
        description: 'Dashboard name — creates if not exists',
      },
      panel_title: { type: 'string', description: 'Override panel title' },
    },
    required: ['block_type', 'content', 'dashboard_title'],
  },
  async execute(args): Promise<ToolResult> {
    if (!args.block_type || !args.content || !args.dashboard_title) {
      return {
        ok: false,
        error: 'block_type, content, and dashboard_title are required',
        code: 'input_invalid',
      };
    }
    return {
      ok: true,
      value: `Save request sent for dashboard "${args.dashboard_title}"`,
      structured: {
        _uiType: 'save_request',
        blockType: args.block_type,
        content: args.content,
        metadata: args.metadata ?? {},
        dashboardTitle: args.dashboard_title,
        panelTitle: args.panel_title,
      },
    };
  },
};
