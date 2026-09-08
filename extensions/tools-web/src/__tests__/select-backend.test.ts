import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { braveBackend, createSearxngBackend, selectSearchBackend } from '../search-backends';

// ---------------------------------------------------------------------------
// selectSearchBackend — direct unit tests for the generic tail (rungs 4-6 of
// the resolution documented in extensions/tools-web/src/index.ts). Rungs 1-3
// (which tools.yaml key a binding comes from) are tool-specific and are
// exercised indirectly, through web_search, in tools-web.test.ts. This file
// pins the shared function on its own so a future caller (e.g. quora_search)
// can rely on it without re-deriving the same coverage through web_search.
// ---------------------------------------------------------------------------

const SEARCH_ENV_KEYS = ['EXA_API_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY'] as const;

function clearSearchEnv(): void {
  for (const k of SEARCH_ENV_KEYS) delete process.env[k];
}

describe('selectSearchBackend', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of SEARCH_ENV_KEYS) saved[k] = process.env[k];
    clearSearchEnv();
  });

  afterEach(() => {
    for (const k of SEARCH_ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // Rung 4: an explicit provider in a binding, with a named secret.
  it('rung 4: an explicit provider binding wins, with a named secret', () => {
    const result = selectSearchBackend({
      bindings: [{ provider: 'exa', secret: 'exa-main' }],
    });
    expect(result).toEqual({
      backend: expect.objectContaining({ id: 'exa' }),
      secretRef: 'providers/exa/exa-main',
    });
  });

  // Rung 4: an explicit provider binding with no secret name falls back to
  // the backend's default-named secret.
  it('rung 4: a provider binding with no secret name uses the default-named secret', () => {
    const result = selectSearchBackend({ bindings: [{ provider: 'tavily' }] });
    expect(result).toEqual({
      backend: expect.objectContaining({ id: 'tavily' }),
      secretRef: 'providers/tavily/apiKey',
    });
  });

  // Rung 4: the first DEFINED entry in the bindings array wins, exactly like
  // the `??` chain it replaces.
  it('rung 4: the first defined binding in the ordered list wins', () => {
    const result = selectSearchBackend({
      bindings: [undefined, { provider: 'brave', secret: 'br' }, { provider: 'exa' }],
    });
    expect(result).toEqual({
      backend: expect.objectContaining({ id: 'brave' }),
      secretRef: 'providers/brave/br',
    });
  });

  // Rung 5: no binding at all — construction-time preference, honoured only
  // when available.
  it('rung 5: construction-time preference is used when available', () => {
    process.env.BRAVE_API_KEY = 'k';
    const result = selectSearchBackend({ bindings: [undefined], searchBackend: 'brave' });
    expect(result).toEqual({ backend: braveBackend, secretRef: 'providers/brave/apiKey' });
  });

  // Rung 5: construction-time preference is skipped when unavailable, and
  // the first available backend is used instead.
  it('rung 5: an unavailable preference falls through to first-available', () => {
    process.env.TAVILY_API_KEY = 'k';
    const result = selectSearchBackend({ bindings: [undefined], searchBackend: 'brave' });
    expect(result).toEqual({
      backend: expect.objectContaining({ id: 'tavily' }),
      secretRef: 'providers/tavily/apiKey',
    });
  });

  // Rung 6: nothing bound, nothing available, keyless SearXNG configured.
  it('rung 6: falls to the keyless SearXNG rung when nothing else resolves', () => {
    const searxng = createSearxngBackend('https://searx.example.com');
    const result = selectSearchBackend({ bindings: [undefined], searxng });
    expect(result).toEqual({ searxng });
  });

  // Nothing resolves at all: no binding, no available backend, no SearXNG.
  it('returns null when nothing resolves', () => {
    const result = selectSearchBackend({ bindings: [undefined] });
    expect(result).toBeNull();
  });
});
