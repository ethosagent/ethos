import {
  buildPromptSummary,
  refreshAllPanels,
  refreshPanelById,
  runPluginQuery,
} from '@ethosagent/dashboard';
import { os } from './context';

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
    const dashboards = context.dashboards?.list('default-user') ?? [];
    return { dashboards };
  }),

  get: os.dashboards.get.handler(async ({ context, input }) => {
    const result = context.dashboards?.get(input.id);
    if (!result) throw new Error('Dashboard not found');
    return result;
  }),

  update: os.dashboards.update.handler(async ({ context, input }) => {
    const { id, ...patch } = input;
    context.dashboards?.update(id, patch);
    return { ok: true as const };
  }),

  delete: os.dashboards.delete.handler(async ({ context, input }) => {
    context.dashboards?.delete(input.id);
    return { ok: true as const };
  }),

  addPanel: os.dashboards.addPanel.handler(async ({ context, input }) => {
    if (!context.dashboards) throw new Error('Dashboards service not configured');
    const panel = context.dashboards.addPanelResolving(input, 'default-user');
    return { panel };
  }),

  updatePanel: os.dashboards.updatePanel.handler(async ({ context, input }) => {
    context.dashboards?.updatePanel(input.panelId, {
      title: input.title,
      cronSchedule: input.cronSchedule,
      queryType: input.queryType,
      prompt: input.prompt,
      sqlQuery: input.sqlQuery,
      pluginId: input.pluginId,
      dataSourceId: input.dataSourceId,
      htmlTemplate: input.htmlTemplate,
      emitConfig: input.emitConfig,
      dependsOn: input.dependsOn,
    });
    return { ok: true as const };
  }),

  updatePanelLayout: os.dashboards.updatePanelLayout.handler(async ({ context, input }) => {
    const { panelId, ...layout } = input;
    context.dashboards?.updatePanelLayout(panelId, layout);
    return { ok: true as const };
  }),

  deletePanel: os.dashboards.deletePanel.handler(async ({ context, input }) => {
    context.dashboards?.deletePanel(input.panelId);
    return { ok: true as const };
  }),

  refreshPanel: os.dashboards.refreshPanel.handler(async ({ context, input }) => {
    await refreshPanelById(input.panelId, context);
    return { ok: true as const };
  }),

  refreshAll: os.dashboards.refreshAll.handler(async ({ context, input }) => {
    await refreshAllPanels(input.dashboardId, context);
    return { ok: true as const };
  }),

  summarizePrompt: os.dashboards.summarizePrompt.handler(async ({ context, input }) => {
    const result = await context.sessions.get(input.sessionId);
    if (!result || result.messages.length === 0) return { summary: '' };
    return { summary: buildPromptSummary(result.messages) };
  }),

  listWidgetTemplates: os.dashboards.listWidgetTemplates.handler(async ({ context }) => {
    const templates = (await context.dashboards?.listWidgetTemplates()) ?? [];
    return { templates };
  }),

  runQuery: os.dashboards.runQuery.handler(async ({ context, input }) => {
    if (!context.pluginLoader) throw new Error('Plugin loader not configured');
    return runPluginQuery(context.pluginLoader, input.pluginId, input.sourceId, input.sql);
  }),

  updateParams: os.dashboards.updateParams.handler(async ({ context, input }) => {
    context.dashboards?.updateDashboardParams(input.id, input.paramsCurrent);
    return { ok: true as const };
  }),

  exportDashboard: os.dashboards.exportDashboard.handler(async ({ context, input }) => {
    const result = context.dashboards?.exportDashboardJson(input.id);
    if (!result) throw new Error('Dashboard not found');
    return result;
  }),

  importDashboard: os.dashboards.importDashboard.handler(async ({ context, input }) => {
    if (!context.dashboards) throw new Error('Dashboards service not configured');
    const result = context.dashboards.importDashboardJson(input.exportJson, 'default-user');
    return { ...result, title: input.titleOverride ?? result.title };
  }),
};
