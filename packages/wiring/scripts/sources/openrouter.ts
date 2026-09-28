export const OPENROUTER_ALLOWLIST_PREFIXES = [
  'anthropic/',
  'google/gemini',
  'openai/gpt',
  'meta-llama/',
  'mistralai/',
  'moonshotai/kimi',
  'deepseek/',
  'x-ai/grok',
  // The static catalog carries qwen rows; without this prefix a live fetch
  // (CATALOG_LIVE_FETCH=1) dropped them.
  'qwen/',
];

export interface OpenRouterModelEntry {
  id: string;
  name: string;
  context_length: number;
  /** Date OpenRouter stops serving the model (`YYYY-MM-DD`), or null. */
  expiration_date?: string | null;
}

export function transformOpenRouterEntry(entry: OpenRouterModelEntry): {
  id: string;
  label: string;
  contextWindow: number;
  retiresOn?: string;
} {
  // `expiration_date` becomes `retiresOn`, so a live-built catalog hides the row
  // on the same day the static one does (`isModelRetired`). Only a leading ISO
  // date is taken; anything else is ignored rather than guessed at.
  const retiresOn = /^\d{4}-\d{2}-\d{2}/.exec(entry.expiration_date ?? '')?.[0];
  return {
    id: entry.id,
    label: retiresOn
      ? `${entry.name}, deprecated — retires ${retiresOn} (OR)`
      : `${entry.name} (OR)`,
    contextWindow: entry.context_length,
    ...(retiresOn ? { retiresOn } : {}),
  };
}

export function filterByAllowlist(models: OpenRouterModelEntry[]): OpenRouterModelEntry[] {
  return models.filter((m) =>
    OPENROUTER_ALLOWLIST_PREFIXES.some((prefix) => m.id.startsWith(prefix)),
  );
}

export async function fetchOpenRouterModels(): Promise<OpenRouterModelEntry[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`OpenRouter returned ${res.status}`);
    const json = (await res.json()) as { data?: unknown[] };
    if (!Array.isArray(json.data)) throw new Error('OpenRouter response missing data array');
    return json.data.filter(
      (m): m is OpenRouterModelEntry =>
        typeof m === 'object' &&
        m !== null &&
        typeof (m as Record<string, unknown>).id === 'string' &&
        typeof (m as Record<string, unknown>).name === 'string' &&
        typeof (m as Record<string, unknown>).context_length === 'number',
    );
  } finally {
    clearTimeout(timeout);
  }
}
