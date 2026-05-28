/**
 * Resolve model display string from a PersonalityConfig.model value.
 * Centralizes the typeof check so consumers don't scatter it.
 */
export function resolveModelDisplay(model, fallback = '(engine default)') {
  if (!model) return fallback;
  if (typeof model === 'string') return model;
  return model.default ?? fallback;
}
