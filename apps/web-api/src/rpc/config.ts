import { os } from './context';

// Config namespace — read returns redacted apiKey preview; update accepts a
// fresh key but doesn't echo it. Service-layer enforces redaction so the
// raw key never exits the host process via this surface.

export const configRouter = {
  get: os.config.get.handler(({ context }) => context.config.get()),

  update: os.config.update.handler(async ({ input, context }) => {
    const { adoptedModels, warnings } = await context.config.update(input);
    return {
      ok: true as const,
      ...(adoptedModels.length > 0 ? { adoptedModels } : {}),
      // B2: unknown-key lines the save kept; the settings save bar shows them.
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }),
};
