import { os } from './context';

// Generic per-tool settings surface. Reads/writes a personality's tool binding
// to the correct store (custom → tools.yaml, built-in → global toolSettings);
// only a secret NAME is ever persisted, never a value.

export const toolSettingsRouter = {
  schemas: os.toolSettings.schemas.handler(({ context }) => context.toolSettings.schemas()),

  getDefault: os.toolSettings.getDefault.handler(({ context }) =>
    context.toolSettings.getDefault(),
  ),

  setDefault: os.toolSettings.setDefault.handler(({ input, context }) =>
    context.toolSettings.setDefault(input.values),
  ),

  getForPersonality: os.toolSettings.getForPersonality.handler(({ input, context }) =>
    context.toolSettings.getForPersonality(input.personalityId),
  ),

  setForPersonality: os.toolSettings.setForPersonality.handler(({ input, context }) =>
    context.toolSettings.setForPersonality(input.personalityId, input.values),
  ),
};
