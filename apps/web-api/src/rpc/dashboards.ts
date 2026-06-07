import { os } from './context';

export const dashboardsRouter = {
  listWidgetTemplates: os.dashboards.listWidgetTemplates.handler(async ({ context }) => {
    const templates = await context.dashboards.listWidgetTemplates();
    return { templates };
  }),
};
