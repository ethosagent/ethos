// ---------------------------------------------------------------------------
// Ollama model pull (keyless-first-run §3.4, D12)
//
// POST <origin>/api/pull { model, stream: true } returns NDJSON lines
// `{ status, digest?, total?, completed? }`, a final `{ status: "success" }`,
// or `{ error }`. Shape pinned by packages/wiring/src/__tests__/ollama-pull.test.ts.
//
// Gates (each pinned by a test in that file):
//  - the URL passes `validateUrl(.., { allowLocalhost: true })` AND the host is
//    127.0.0.1 / localhost / ::1 ("refuses a non-local base URL");
//  - `model` is one of KEYLESS_MODEL_IDS ("refuses a model outside the tier table").
// ---------------------------------------------------------------------------

import { validateUrl } from '@ethosagent/core';
import { KEYLESS_MODEL_IDS } from './keyless-models';

export interface OllamaPullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

export interface PullOllamaModelOptions {
  /** With or without the `/v1` suffix; only the origin is used. */
  baseUrl: string;
  model: string;
  signal?: AbortSignal;
  onProgress?: (p: OllamaPullProgress) => void;
  fetchImpl?: typeof fetch;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export class OllamaPullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaPullError';
  }
}

function localOrigin(baseUrl: string): string {
  const url = validateUrl(baseUrl, { allowLocalhost: true });
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!LOCAL_HOSTS.has(host)) {
    throw new OllamaPullError(`Refusing to pull from a non-local host: ${host}`);
  }
  return url.origin;
}

/** Narrow one parsed NDJSON line. Returns an error string, a progress record,
 *  or null for a line we do not understand (ignored). */
function parseLine(raw: unknown): { error: string } | { progress: OllamaPullProgress } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.error === 'string') return { error: rec.error };
  if (typeof rec.status !== 'string') return null;
  const progress: OllamaPullProgress = { status: rec.status };
  if (typeof rec.digest === 'string') progress.digest = rec.digest;
  if (typeof rec.total === 'number') progress.total = rec.total;
  if (typeof rec.completed === 'number') progress.completed = rec.completed;
  return { progress };
}

export async function pullOllamaModel(opts: PullOllamaModelOptions): Promise<void> {
  if (!KEYLESS_MODEL_IDS.some((id) => id === opts.model)) {
    throw new OllamaPullError(
      `Refusing to pull a model outside the keyless tier table: ${opts.model}`,
    );
  }
  const origin = localOrigin(opts.baseUrl);
  const fetchImpl = opts.fetchImpl ?? fetch;

  const res = await fetchImpl(`${origin}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: opts.model, stream: true }),
    signal: opts.signal,
  });
  if (!res.ok) throw new OllamaPullError(`Ollama pull failed: HTTP ${res.status}`);
  if (!res.body) throw new OllamaPullError('Ollama pull returned no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let succeeded = false;

  const handle = (line: string): void => {
    if (line.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const out = parseLine(parsed);
    if (out === null) return;
    if ('error' in out) throw new OllamaPullError(out.error);
    opts.onProgress?.(out.progress);
    if (out.progress.status === 'success') succeeded = true;
  };

  try {
    for (;;) {
      if (opts.signal?.aborted)
        throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        handle(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
      if (succeeded) return;
    }
    handle(buffer);
  } finally {
    reader.cancel().catch(() => {});
  }
  if (!succeeded) throw new OllamaPullError('Ollama pull ended without a success status');
}
