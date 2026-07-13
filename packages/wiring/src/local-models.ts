// ---------------------------------------------------------------------------
// Local OpenAI-compatible model discovery
//
// Shared by both setup paths — the readline fallback (apps/ethos) and the Ink
// TUI wizard (apps/tui) — so the `GET /v1/models` protocol lives in exactly one
// place. Local providers (ollama, vllm) serve their model list here; setup
// offers it as a pick-list and falls back to free-text entry when unreachable.
// ---------------------------------------------------------------------------

/** Extract model ids from an OpenAI-compatible `GET /v1/models` body.
 *  Shape: `{ data: [{ id: string }, ...] }`. Structural guard only — anything
 *  that doesn't match yields an empty list (no `as` casts). */
export function parseOpenAiModelsResponse(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) ids.push(id);
  }
  return ids;
}

export interface LocalModelsResult {
  /** Whether the endpoint answered a well-formed model list in time. */
  reachable: boolean;
  models: string[];
}

/** Fetch the served model list from a local OpenAI-compatible endpoint.
 *  Times out fast so setup never hangs on an unreachable endpoint; any
 *  failure (network error, timeout, non-2xx, malformed body) reports
 *  `reachable: false` so the caller falls back to a free-text model prompt. */
export async function fetchLocalModels(
  baseUrl: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<LocalModelsResult> {
  const timeoutMs = opts.timeoutMs ?? 2500;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { reachable: false, models: [] };
    const body: unknown = await res.json();
    const models = parseOpenAiModelsResponse(body);
    if (models.length === 0) return { reachable: false, models: [] };
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  }
}
