import { os } from './context';
export const pluginsRouter = {
  list: os.plugins.list.handler(({ context }) => context.plugins.list()),
  install: os.plugins.install.handler(async ({ context, input }) => {
    await context.plugins.install(input.packageSpec);
    return { ok: true };
  }),
  uninstall: os.plugins.uninstall.handler(async ({ context, input }) => {
    await context.plugins.uninstall(input.pluginId);
    return { ok: true };
  }),
};
