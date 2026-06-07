import type { RpcContext } from './context';
import { os } from './context';

// ---------------------------------------------------------------------------
// Shared single-panel refresh — used by both refreshPanel and refreshAll
// ---------------------------------------------------------------------------

async function refreshSinglePanel(
  panel: {
    id: string;
    dashboardId: string;
    queryType: string;
    blockType: string;
    prompt: string | null;
    sqlQuery: string | null;
    pluginId: string | null;
    dataSourceId: string | null;
  },
  context: RpcContext,
): Promise<void> {
  // SQL refresh
  if (panel.queryType === 'sql' && panel.sqlQuery && panel.pluginId && panel.dataSourceId) {
    try {
      const { default: Database } = await import('better-sqlite3');
      const pluginLoader = context.pluginLoader;
      if (!pluginLoader) throw new Error('Plugin loader not configured');
      const dbPath = pluginLoader.getDataSourcePath(panel.pluginId, panel.dataSourceId);
      if (!dbPath)
        throw new Error(
          `Data source '${panel.dataSourceId}' not registered by plugin '${panel.pluginId}'`,
        );
      const db = new Database(dbPath, { readonly: true });
      try {
        const stmt = db.prepare(panel.sqlQuery);
        const rows = stmt.all();
        context.dashboards?.updatePanelContent(panel.id, JSON.stringify(rows));
        context.dashboards?.clearPanelError(panel.id);
      } finally {
        db.close();
      }
    } catch (err) {
      context.dashboards?.setPanelError(panel.id, err instanceof Error ? err.message : String(err));
    }
  }

  // Prompt refresh via AgentLoop
  if (panel.queryType === 'prompt' && panel.prompt) {
    const loop = context.agentLoop;
    if (!loop) {
      context.dashboards?.setPanelError(panel.id, 'Agent loop not configured');
      return;
    }
    try {
      // Get the dashboard to find its personality
      const dashResult = context.dashboards?.get(panel.dashboardId);
      const personalityId = dashResult?.dashboard?.personalityId;

      // Inject dashboard widget context into the prompt
      const widgetContext =
        '## Dashboard widget context\nYou are rendering output for a dashboard widget, not a conversational response.\n- No conversational preamble or postamble\n- Prefer render_html for charts and tables — output must be self-contained and visually compact\n- For tabular data, always use a styled HTML table, not markdown\n- Keep output compact and scannable for a fixed-size panel';
      const fullPrompt = `${widgetContext}\n\n${panel.prompt}`;

      // Run through AgentLoop
      const sessionKey = `dashboard:${panel.dashboardId}:${panel.id}:${Date.now()}`;
      let output = '';
      let structured: unknown = null;
      for await (const event of loop.run(fullPrompt, {
        sessionKey,
        ...(personalityId ? { personalityId } : {}),
      })) {
        if (event.type === 'text_delta') output += event.text;
        if (event.type === 'tool_end' && 'structured' in event) {
          structured = (event as { structured?: unknown }).structured;
        }
      }

      // Check for structured output (render_html returns _uiType: 'html')
      const content =
        structured && typeof structured === 'object' && '_uiType' in structured
          ? ((structured as { content?: string }).content ?? output)
          : output;

      context.dashboards?.updatePanelContent(panel.id, content);
      context.dashboards?.clearPanelError(panel.id);
    } catch (err) {
      context.dashboards?.setPanelError(panel.id, err instanceof Error ? err.message : String(err));
    }
  }
}

export const dashboardsRouter = {
  create: os.dashboards.create.handler(async ({ context, input }) => {
    const dashboard = context.dashboards?.create(
      'default-user' /* TODO: replace with auth-context userId once user scoping lands */,
      input.title,
      input.personalityId,
      input.description,
    );
    if (!dashboard) throw new Error('Dashboards service not configured');
    return { dashboard };
  }),

  list: os.dashboards.list.handler(async ({ context }) => {
    const dashboards =
      context.dashboards?.list(
        'default-user' /* TODO: replace with auth-context userId once user scoping lands */,
      ) ?? [];
    return { dashboards };
  }),

  get: os.dashboards.get.handler(async ({ context, input }) => {
    const result = context.dashboards?.get(input.id);
    if (!result) throw new Error('Dashboard not found');
    return result;
  }),

  update: os.dashboards.update.handler(async ({ context, input }) => {
    context.dashboards?.update(input.id, {
      title: input.title,
      description: input.description,
    });
    return { ok: true as const };
  }),

  delete: os.dashboards.delete.handler(async ({ context, input }) => {
    context.dashboards?.delete(input.id);
    return { ok: true as const };
  }),

  addPanel: os.dashboards.addPanel.handler(async ({ context, input }) => {
    let dashboardId = input.dashboardId;
    if (!dashboardId && input.newDashboardTitle) {
      const dashboard = context.dashboards?.create(
        'default-user' /* TODO: replace with auth-context userId once user scoping lands */,
        input.newDashboardTitle,
        input.personalityId ?? 'default',
      );
      if (!dashboard) throw new Error('Dashboards service not configured');
      dashboardId = dashboard.id;
    }
    if (!dashboardId) throw new Error('dashboardId or newDashboardTitle required');
    const panel = context.dashboards?.addPanel(dashboardId, input.panel);
    if (!panel) throw new Error('Dashboards service not configured');
    return { panel };
  }),

  updatePanel: os.dashboards.updatePanel.handler(async ({ context, input }) => {
    context.dashboards?.updatePanel(input.panelId, {
      title: input.title,
      cronSchedule: input.cronSchedule,
    });
    return { ok: true as const };
  }),

  updatePanelLayout: os.dashboards.updatePanelLayout.handler(async ({ context, input }) => {
    context.dashboards?.updatePanelLayout(input.panelId, {
      col: input.col,
      row: input.row,
      w: input.w,
      h: input.h,
    });
    return { ok: true as const };
  }),

  deletePanel: os.dashboards.deletePanel.handler(async ({ context, input }) => {
    context.dashboards?.deletePanel(input.panelId);
    return { ok: true as const };
  }),

  refreshPanel: os.dashboards.refreshPanel.handler(async ({ context, input }) => {
    const panel = context.dashboards?.getPanel(input.panelId);
    if (!panel) throw new Error('Panel not found');
    await refreshSinglePanel(panel, context);
    return { ok: true as const };
  }),

  refreshAll: os.dashboards.refreshAll.handler(async ({ context, input }) => {
    const panels = context.dashboards?.listLivePanels(input.dashboardId) ?? [];
    for (const panel of panels) {
      await refreshSinglePanel(panel, context);
    }
    return { ok: true as const };
  }),

  summarizePrompt: os.dashboards.summarizePrompt.handler(async ({ context, input }) => {
    const result = await context.sessions.get(input.sessionId);
    if (!result || result.messages.length === 0) {
      return { summary: '' };
    }
    // Build a condensed text-based summary from the conversation
    const parts: string[] = [];
    for (const msg of result.messages) {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (text.length > 500) {
        parts.push(`${role}: ${text.slice(0, 500)}...`);
      } else {
        parts.push(`${role}: ${text}`);
      }
    }
    const summary = `Based on the following conversation, produce the same kind of output:\n\n${parts.join('\n\n')}`;
    return { summary };
  }),

  listWidgetTemplates: os.dashboards.listWidgetTemplates.handler(async ({ context }) => {
    const templates = (await context.dashboards?.listWidgetTemplates()) ?? [];
    return { templates };
  }),
};
