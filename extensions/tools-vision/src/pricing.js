// Capability table for vision_analyze. v1 — hardcoded; one row per model.
//
// Both flags default to false for unknown models. Adding a new model is a
// one-row table extension; the per-model pricing data lives upstream in the
// provider catalog and flows through `TokenUsage.estimatedCostUsd` (already
// computed by the LLM adapter), so we don't duplicate prices here.
// Keep this table small and obvious. New entries go alphabetically inside
// each vendor block. Aliases (e.g. dated suffixes) are NOT inferred — list
// each model id explicitly to keep the gate deterministic.
const CAPABILITIES = {
  // Anthropic
  'claude-opus-4-6': { vision: true, pdf: true, videoUrl: true },
  'claude-opus-4-7': { vision: true, pdf: true, videoUrl: true },
  'claude-sonnet-4-6': { vision: true, pdf: true, videoUrl: true },
  // OpenAI / Azure OpenAI / Azure AI Foundry
  // Azure deployment names follow the base-model id by convention; these
  // entries cover both direct OpenAI and Azure-Foundry-served deployments
  // that match the canonical name. PDF support pairs with vision for the
  // 5.x family (Microsoft Foundry docs).
  'gpt-5': { vision: true, pdf: true, videoUrl: true },
  'gpt-5-mini': { vision: true, pdf: true, videoUrl: true },
  'gpt-5.4': { vision: true, pdf: true, videoUrl: true },
  'gpt-5.4-pro': { vision: true, pdf: true, videoUrl: true },
  'gpt-5.4-mini': { vision: true, pdf: true, videoUrl: true },
  // Google
  'gemini-2.5-pro': { vision: true, pdf: true, videoUrl: true },
  'gemini-2.5-flash': { vision: true, pdf: true, videoUrl: true },
};
export function supportsVision(model) {
  return CAPABILITIES[model]?.vision === true;
}
export function supportsPdf(model) {
  return CAPABILITIES[model]?.pdf === true;
}
export function supportsVideoUrl(model) {
  return CAPABILITIES[model]?.videoUrl === true;
}
