import type { AgentLoop } from '@ethosagent/core';
import type { PluginLoader } from '@ethosagent/plugin-loader';
import type { DashboardPanel } from './dashboards.service';
import { extractParamRefs, interpolateParams } from './interpolate-params';

export interface RefreshablePanelData {
  id: string;
  dashboardId: string;
  queryType: string;
  blockType: string;
  prompt: string | null;
  sqlQuery: string | null;
  pluginId: string | null;
  dataSourceId: string | null;
  htmlTemplate: string | null;
  paramDefaults: Record<string, string>;
  dependsOn: string[] | null;
}

/** Minimal surface of DashboardsService needed for panel refresh. */
export interface RefreshDashboardsHandle {
  get(id: string): {
    dashboard: { personalityId: string; paramsCurrent: Record<string, string> };
    panels: DashboardPanel[];
  } | null;
  updatePanelContent(panelId: string, content: string, blockType?: string): void;
  setPanelError(panelId: string, error: string): void;
  clearPanelError(panelId: string): void;
  updatePanelParamDefaults(panelId: string, values: Record<string, string>): void;
}

interface RefreshDeps {
  dashboards: RefreshDashboardsHandle;
  pluginLoader?: PluginLoader;
  agentLoop?: AgentLoop;
}

/**
 * Deps for the RPC-facing orchestration helpers below. `dashboards` is
 * optional so handlers can pass their context straight through; the helpers
 * fail the same way the inline handler logic used to.
 */
export interface RefreshOrchestratorDeps {
  dashboards?: RefreshDashboardsHandle & {
    getPanel(panelId: string): DashboardPanel | null;
    listLivePanels(dashboardId: string): DashboardPanel[];
  };
  pluginLoader?: PluginLoader;
  agentLoop?: AgentLoop;
}

/** Refresh one panel by id, resolving its dashboard's persistent params. */
export async function refreshPanelById(
  panelId: string,
  deps: RefreshOrchestratorDeps,
): Promise<void> {
  const dashboards = deps.dashboards;
  const panel = dashboards?.getPanel(panelId);
  if (!panel) throw new Error('Panel not found');
  if (!dashboards) throw new Error('Dashboards service not configured');
  const persistent = dashboards.get(panel.dashboardId)?.dashboard.paramsCurrent ?? {};
  await refreshSinglePanel(
    panel,
    { dashboards, pluginLoader: deps.pluginLoader, agentLoop: deps.agentLoop },
    { persistent },
  );
}

/** Refresh every live panel of a dashboard with its persistent params. */
export async function refreshAllPanels(
  dashboardId: string,
  deps: RefreshOrchestratorDeps,
): Promise<void> {
  const dashboards = deps.dashboards;
  if (!dashboards) return;
  const persistent = dashboards.get(dashboardId)?.dashboard.paramsCurrent ?? {};
  for (const panel of dashboards.listLivePanels(dashboardId)) {
    await refreshSinglePanel(
      panel,
      { dashboards, pluginLoader: deps.pluginLoader, agentLoop: deps.agentLoop },
      { persistent },
    );
  }
}

export async function refreshSinglePanel(
  panel: RefreshablePanelData,
  deps: RefreshDeps,
  params?: {
    ephemeral?: Record<string, string>;
    persistent?: Record<string, string>;
  },
): Promise<void> {
  if (panel.queryType === 'header') return;

  const ephemeral = params?.ephemeral ?? {};
  const persistent = params?.persistent ?? {};
  const panelDefaults = panel.paramDefaults ?? {};
  const sqlQuery = panel.sqlQuery
    ? interpolateParams(panel.sqlQuery, ephemeral, persistent, panelDefaults)
    : null;
  const prompt = panel.prompt
    ? interpolateParams(panel.prompt, ephemeral, persistent, panelDefaults)
    : null;

  // SQL refresh
  if (panel.queryType === 'sql' && sqlQuery && panel.pluginId && panel.dataSourceId) {
    try {
      const { default: Database } = await import('@ethosagent/sqlite');
      const pluginLoader = deps.pluginLoader;
      if (!pluginLoader) throw new Error('Plugin loader not configured');
      const dbPath = pluginLoader.getDataSourcePath(panel.pluginId, panel.dataSourceId);
      if (!dbPath)
        throw new Error(
          `Data source '${panel.dataSourceId}' not registered by plugin '${panel.pluginId}'`,
        );
      const db = new Database(dbPath, { readonly: true });
      try {
        const stmt = db.prepare(sqlQuery);
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
        writeBackParams(panel, ephemeral, persistent, panelDefaults, deps);
      } finally {
        db.close();
      }
    } catch (err) {
      deps.dashboards.setPanelError(panel.id, err instanceof Error ? err.message : String(err));
    }
  }

  // Prompt refresh via AgentLoop
  if (panel.queryType === 'prompt' && prompt) {
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
      const fullPrompt = `${widgetContext}\n\n${prompt}`;

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
      writeBackParams(panel, ephemeral, persistent, panelDefaults, deps);
    } catch (err) {
      deps.dashboards.setPanelError(panel.id, err instanceof Error ? err.message : String(err));
    }
  }
}

function writeBackParams(
  panel: RefreshablePanelData,
  ephemeral: Record<string, string>,
  persistent: Record<string, string>,
  panelDefaults: Record<string, string>,
  deps: RefreshDeps,
): void {
  const template = (panel.sqlQuery ?? '') + (panel.prompt ?? '');
  const refs = extractParamRefs(template);
  if (refs.length > 0) {
    const usedValues: Record<string, string> = {};
    for (const key of refs) {
      const val = ephemeral[key] ?? persistent[key] ?? panelDefaults[key];
      if (val !== undefined) usedValues[key] = val;
    }
    if (Object.keys(usedValues).length > 0) {
      deps.dashboards.updatePanelParamDefaults(panel.id, usedValues);
    }
  }
}

export function buildRefreshLayers(panels: RefreshablePanelData[]): RefreshablePanelData[][] {
  const inDegree = new Map(panels.map((p) => [p.id, (p.dependsOn ?? []).length]));
  const ready = panels.filter((p) => inDegree.get(p.id) === 0);
  const layers: RefreshablePanelData[][] = [];

  while (ready.length > 0) {
    layers.push([...ready]);
    const next: RefreshablePanelData[] = [];
    for (const p of ready) {
      for (const candidate of panels) {
        if (candidate.dependsOn?.includes(p.id)) {
          const deg = (inDegree.get(candidate.id) ?? 1) - 1;
          inDegree.set(candidate.id, deg);
          if (deg === 0) next.push(candidate);
        }
      }
    }
    ready.length = 0;
    ready.push(...next);
  }

  return layers;
}
