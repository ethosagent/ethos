import type { AgentLoop } from '@ethosagent/core';
import type { PluginLoader } from '@ethosagent/plugin-loader';
import type { DashboardPanel } from './dashboards.service';

interface RefreshablePanelData {
  id: string;
  dashboardId: string;
  queryType: string;
  blockType: string;
  prompt: string | null;
  sqlQuery: string | null;
  pluginId: string | null;
  dataSourceId: string | null;
  htmlTemplate: string | null;
}

/** Minimal surface of DashboardsService needed for panel refresh. */
export interface RefreshDashboardsHandle {
  get(id: string): { dashboard: { personalityId: string }; panels: DashboardPanel[] } | null;
  updatePanelContent(panelId: string, content: string, blockType?: string): void;
  setPanelError(panelId: string, error: string): void;
  clearPanelError(panelId: string): void;
}

interface RefreshDeps {
  dashboards: RefreshDashboardsHandle;
  pluginLoader?: PluginLoader;
  agentLoop?: AgentLoop;
}

export async function refreshSinglePanel(
  panel: RefreshablePanelData,
  deps: RefreshDeps,
): Promise<void> {
  // SQL refresh
  if (panel.queryType === 'sql' && panel.sqlQuery && panel.pluginId && panel.dataSourceId) {
    try {
      const { default: Database } = await import('better-sqlite3');
      const pluginLoader = deps.pluginLoader;
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
        if (panel.htmlTemplate && rows.length > 0) {
          const html = panel.htmlTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => {
            if (key === 'rows_json') return JSON.stringify(rows);
            const row = rows[0] as Record<string, unknown>;
            return String(row?.[key] ?? '');
          });
          deps.dashboards.updatePanelContent(panel.id, html, 'html');
        } else {
          deps.dashboards.updatePanelContent(panel.id, JSON.stringify(rows));
        }
        deps.dashboards.clearPanelError(panel.id);
      } finally {
        db.close();
      }
    } catch (err) {
      deps.dashboards.setPanelError(panel.id, err instanceof Error ? err.message : String(err));
    }
  }

  // Prompt refresh via AgentLoop
  if (panel.queryType === 'prompt' && panel.prompt) {
    const loop = deps.agentLoop;
    if (!loop) {
      deps.dashboards.setPanelError(panel.id, 'Agent loop not configured');
      return;
    }
    try {
      // Get the dashboard to find its personality
      const dashResult = deps.dashboards.get(panel.dashboardId);
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

      deps.dashboards.updatePanelContent(panel.id, content);
      deps.dashboards.clearPanelError(panel.id);
    } catch (err) {
      deps.dashboards.setPanelError(panel.id, err instanceof Error ? err.message : String(err));
    }
  }
}
