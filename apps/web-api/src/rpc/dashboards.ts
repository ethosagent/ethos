import { refreshSinglePanel } from '../services/dashboard-refresh';
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
    if (!context.dashboards) throw new Error('Dashboards service not configured');
    await refreshSinglePanel(panel, {
      dashboards: context.dashboards,
      pluginLoader: context.pluginLoader,
      agentLoop: context.agentLoop,
    });
    return { ok: true as const };
  }),

  refreshAll: os.dashboards.refreshAll.handler(async ({ context, input }) => {
    const panels = context.dashboards?.listLivePanels(input.dashboardId) ?? [];
    if (!context.dashboards) return { ok: true as const };
    for (const panel of panels) {
      await refreshSinglePanel(panel, {
        dashboards: context.dashboards,
        pluginLoader: context.pluginLoader,
        agentLoop: context.agentLoop,
      });
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
