import { os } from './context';

export const dashboardsRouter = {
  create: os.dashboards.create.handler(async ({ context, input }) => {
    const dashboard = context.dashboards?.create(
      'default-user',
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
        'default-user',
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
    // SQL refresh: execute query against plugin db
    if (panel.queryType === 'sql' && panel.sqlQuery && panel.pluginId && panel.dataSourceId) {
      try {
        // For now, store an empty result — real execution would go through
        // the plugin loader's data-source interface.
        context.dashboards?.updatePanelContent(input.panelId, '[]');
        context.dashboards?.clearPanelError(input.panelId);
      } catch (err) {
        context.dashboards?.setPanelError(input.panelId, String(err));
      }
    }
    // Prompt refresh would go through AgentLoop — stub for now
    return { ok: true as const };
  }),

  refreshAll: os.dashboards.refreshAll.handler(async ({ context, input }) => {
    const panels = context.dashboards?.listLivePanels(input.dashboardId) ?? [];
    for (const panel of panels) {
      try {
        if (panel.queryType === 'sql' && panel.sqlQuery) {
          context.dashboards?.updatePanelContent(panel.id, '[]');
          context.dashboards?.clearPanelError(panel.id);
        }
      } catch (err) {
        context.dashboards?.setPanelError(panel.id, String(err));
      }
    }
    return { ok: true as const };
  }),

  listWidgetTemplates: os.dashboards.listWidgetTemplates.handler(async ({ context }) => {
    const templates = (await context.dashboards?.listWidgetTemplates()) ?? [];
    return { templates };
  }),
};
