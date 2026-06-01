export const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0';
export const CODEX_DISCOVERY_TIMEOUT_MS = 10_000;

export const CODEX_FALLBACK_MODELS = [
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
];

export async function discoverModels(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CODEX_DISCOVERY_TIMEOUT_MS);
    const res = await fetchFn(CODEX_MODELS_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return CODEX_FALLBACK_MODELS;
    const data = (await res.json()) as { models?: Array<{ id: string }> };
    if (!data.models || data.models.length === 0) return CODEX_FALLBACK_MODELS;
    return data.models.map((m) => m.id);
  } catch {
    return CODEX_FALLBACK_MODELS;
  }
}
