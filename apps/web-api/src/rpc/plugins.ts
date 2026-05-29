import { os } from './context';

export const pluginsRouter = {
  list: os.plugins.list.handler(({ context }) => context.plugins.list()),
  install: os.plugins.install.handler(async ({ context, input }) => {
    await context.plugins.install(input.packageSpec);
    return { ok: true as const };
  }),
  uninstall: os.plugins.uninstall.handler(async ({ context, input }) => {
    await context.plugins.uninstall(input.pluginId);
    return { ok: true as const };
  }),
  setCredential: os.plugins.setCredential.handler(async ({ context, input }) => {
    await context.plugins.setCredential(input.pluginId, input.key, input.value);
    return { ok: true as const };
  }),
  getCredentialMeta: os.plugins.getCredentialMeta.handler(async ({ context, input }) => {
    const meta = await context.plugins.getCredentialMeta(input.pluginId, input.key);
    return { updatedAt: meta?.updatedAt ?? null };
  }),
  listCredentialKeys: os.plugins.listCredentialKeys.handler(async ({ context, input }) => {
    const keys = await context.plugins.listCredentialKeys(input.pluginId);
    return { keys };
  }),
  getPageSpec: os.plugins.getPageSpec.handler(async ({ context, input }) => {
    const spec = await context.plugins.getPageSpec(input.pluginId);
    return { spec: spec ?? null };
  }),
  invokeToolForPage: os.plugins.invokeToolForPage.handler(async ({ context, input }) => {
    return context.plugins.invokeToolForPage(
      input.pluginId,
      input.toolName,
      input.args,
      context.toolRegistry,
    );
  }),
  getCredential: os.plugins.getCredential.handler(async ({ context, input }) => {
    const value = await context.plugins.getCredential(input.pluginId, input.ref);
    return { value };
  }),
  credentialPreview: os.plugins.credentialPreview.handler(async ({ context, input }) => {
    const preview = await context.plugins.credentialPreview(input.pluginId, input.ref);
    return { preview };
  }),
  executeTool: os.plugins.executeTool.handler(async ({ context, input }) => {
    return context.plugins.executeTool(
      input.pluginId,
      input.toolName,
      input.args,
      context.toolRegistry,
    );
  }),
};
