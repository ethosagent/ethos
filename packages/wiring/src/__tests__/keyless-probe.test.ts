import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_CONTEXT_FLOOR_TOKENS } from '@ethosagent/llm-openai-compat';
import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeKeylessCandidate, probeKeyless } from '../keyless-probe';

const GIB = 1024 ** 3;
const FAKE_ACCESS = 'fakeAccessTokenValue.payload.sig';
const FAKE_REFRESH = 'fakeRefreshTokenValue';
const FAKE_ID = 'fakeIdTokenValue.payload.sig';

function modelsBody(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
}

/** Fake fetch: `servers` maps an origin ("127.0.0.1:11434") to its model ids. */
function makeFetch(servers: Record<string, string[]>, ollamaWindow?: number) {
  const urls: string[] = [];
  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const u = new URL(url);
    const ids = servers[u.host];
    if (!ids) throw new Error('ECONNREFUSED');
    if (u.pathname.endsWith('/api/ps')) {
      const models =
        ollamaWindow === undefined
          ? []
          : ids.map((name) => ({ name, model: name, context_length: ollamaWindow }));
      return new Response(JSON.stringify({ models }));
    }
    return modelsBody(ids);
  }) as unknown as typeof fetch;
  return { impl, urls };
}

describe('probeKeyless', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'keyless-probe-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function writeCodexLogin(dir: '.codex' | '.hermes' = '.codex') {
    await mkdir(join(home, dir), { recursive: true });
    await writeFile(
      join(home, dir, 'auth.json'),
      JSON.stringify({
        tokens: { access_token: FAKE_ACCESS, refresh_token: FAKE_REFRESH, id_token: FAKE_ID },
      }),
    );
  }

  const base = (secrets: InMemorySecretsResolver, fetchImpl: typeof fetch) => ({
    secrets,
    platform: 'linux' as NodeJS.Platform,
    totalMemBytes: 16 * GIB,
    isRoot: false,
    fetchImpl,
    home,
  });

  it('an ethos-held codex login is recommended over everything', async () => {
    const secrets = new InMemorySecretsResolver();
    await secrets.set(
      'providers/codex/tokens',
      JSON.stringify({
        accessToken: 'a',
        refreshToken: 'r',
        idToken: 'i',
        accountId: 'acct',
        expiresAt: '2099-01-01T00:00:00.000Z',
        updatedAt: '2099-01-01T00:00:00.000Z',
      }),
    );
    await writeCodexLogin();
    const { impl } = makeFetch({ '127.0.0.1:11434': ['llama3.2:latest'] });
    const res = await probeKeyless(base(secrets, impl));
    expect(res.candidates[res.recommended]).toEqual({ kind: 'ethos-login', provider: 'codex' });
    expect(res.candidates.map((c) => c.kind)).toEqual(['ethos-login', 'local', 'paste-key']);
  });

  it('a ~/.codex/auth.json is reported as external-login and nothing is written to secrets', async () => {
    await writeCodexLogin();
    const secrets = new InMemorySecretsResolver();
    const setSpy = vi.spyOn(secrets, 'set');
    const { impl } = makeFetch({});
    const res = await probeKeyless(base(secrets, impl));
    expect(res.candidates[0]).toEqual({
      kind: 'external-login',
      source: 'codex-cli',
      provider: 'codex',
      path: join(home, '.codex', 'auth.json'),
    });
    expect(setSpy).not.toHaveBeenCalled();
    expect(await secrets.get('providers/codex/tokens')).toBeNull();
  });

  it('reports codex-cli before hermes when both exist', async () => {
    await writeCodexLogin('.hermes');
    await writeCodexLogin('.codex');
    const res = await probeKeyless(base(new InMemorySecretsResolver(), makeFetch({}).impl));
    const sources = res.candidates.flatMap((c) => (c.kind === 'external-login' ? [c.source] : []));
    expect(sources).toEqual(['codex-cli', 'hermes']);
  });

  it('the result carries no token material', async () => {
    await writeCodexLogin();
    const res = await probeKeyless(base(new InMemorySecretsResolver(), makeFetch({}).impl));
    const dump = JSON.stringify(res);
    for (const needle of [
      FAKE_ACCESS,
      FAKE_REFRESH,
      FAKE_ID,
      'access_token',
      'refresh_token',
      'id_token',
    ]) {
      expect(dump).not.toContain(needle);
    }
  });

  it('an Ollama answering /v1/models is recommended when no login exists', async () => {
    const { impl } = makeFetch({ '127.0.0.1:11434': ['llama3.2:latest'] });
    const res = await probeKeyless(base(new InMemorySecretsResolver(), impl));
    expect(res.candidates[res.recommended]).toMatchObject({
      kind: 'local',
      runtime: 'ollama',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: ['llama3.2:latest'],
    });
    // A local server exists, so no install offer.
    expect(res.candidates.map((c) => c.kind)).toEqual(['local', 'paste-key']);
  });

  it('below-floor local is flagged with served and floor tokens', async () => {
    const { impl } = makeFetch({ '127.0.0.1:11434': ['llama3.2:latest'] }, 8192);
    const res = await probeKeyless(base(new InMemorySecretsResolver(), impl));
    expect(res.candidates[0]).toMatchObject({
      kind: 'local',
      contextWindow: 8192,
      belowContextFloor: { servedTokens: 8192, floorTokens: LOCAL_CONTEXT_FLOOR_TOKENS },
    });
  });

  it('below-floor local is not recommended over another usable local', async () => {
    const { impl } = makeFetch(
      { '127.0.0.1:11434': ['llama3.2:latest'], '127.0.0.1:8000': ['m'] },
      8192,
    );
    const res = await probeKeyless(base(new InMemorySecretsResolver(), impl));
    const rec = res.candidates[res.recommended];
    expect(rec).toMatchObject({ kind: 'local', runtime: 'vllm' });
    expect(res.candidates.some((c) => c.kind === 'local' && c.runtime === 'ollama')).toBe(true);
  });

  it('below-floor local alone stays first and is never preferred over a login', async () => {
    const { impl } = makeFetch({ '127.0.0.1:11434': ['llama3.2:latest'] }, 8192);
    const alone = await probeKeyless(base(new InMemorySecretsResolver(), impl));
    expect(alone.recommended).toBe(0);
    await writeCodexLogin();
    const withLogin = await probeKeyless(base(new InMemorySecretsResolver(), impl));
    expect(withLogin.candidates[withLogin.recommended]?.kind).toBe('external-login');
  });

  it('a window at or above the floor, or unknown, is not flagged', async () => {
    for (const w of [LOCAL_CONTEXT_FLOOR_TOKENS, 32768, undefined]) {
      const { impl } = makeFetch({ '127.0.0.1:11434': ['llama3.2:latest'] }, w);
      const res = await probeKeyless(base(new InMemorySecretsResolver(), impl));
      const c = res.candidates[0];
      expect(c?.kind === 'local' && c.belowContextFloor).toBeFalsy();
    }
  });

  it('describeKeylessCandidate carries the remediation for a below-floor local', () => {
    const local = {
      kind: 'local' as const,
      runtime: 'ollama' as const,
      provider: 'ollama' as const,
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: ['m'],
      belowContextFloor: { servedTokens: 8192, floorTokens: 16000 },
    };
    expect(describeKeylessCandidate(local).hint).toBe(
      'serves 8192 tokens; Ethos needs 16000 — restart Ollama with a larger context (e.g. OLLAMA_CONTEXT_LENGTH=16384), then choose this again',
    );
    expect(describeKeylessCandidate({ ...local, runtime: 'vllm', provider: 'vllm' }).hint).toMatch(
      /--max-model-len \/ -c \/ model settings/,
    );
    const ok = { ...local, belowContextFloor: undefined };
    expect(describeKeylessCandidate(ok).hint).toBe('running at http://127.0.0.1:11434/v1');
  });

  it('maps llama.cpp and LM Studio to openai-compat and vllm to vllm', async () => {
    const { impl } = makeFetch({
      '127.0.0.1:8000': ['m-vllm'],
      '127.0.0.1:8080': ['m-llama'],
      '127.0.0.1:1234': ['m-lms'],
    });
    const res = await probeKeyless(base(new InMemorySecretsResolver(), impl));
    const locals = res.candidates.flatMap((c) =>
      c.kind === 'local' ? [[c.runtime, c.provider, c.baseUrl]] : [],
    );
    expect(locals).toEqual([
      ['vllm', 'vllm', 'http://127.0.0.1:8000/v1'],
      ['llamacpp', 'openai-compat', 'http://127.0.0.1:8080/v1'],
      ['lmstudio', 'openai-compat', 'http://127.0.0.1:1234/v1'],
    ]);
  });

  it('a server answering an empty model list is not a candidate', async () => {
    const { impl } = makeFetch({ '127.0.0.1:11434': [] });
    const res = await probeKeyless(base(new InMemorySecretsResolver(), impl));
    expect(res.candidates.some((c) => c.kind === 'local')).toBe(false);
  });

  it('only 127.0.0.1 is probed', async () => {
    const { impl, urls } = makeFetch({ '127.0.0.1:11434': ['a'] });
    await probeKeyless(base(new InMemorySecretsResolver(), impl));
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(new URL(u).hostname).toBe('127.0.0.1');
  });

  it('no local server → install-offer then paste-key', async () => {
    const res = await probeKeyless(base(new InMemorySecretsResolver(), makeFetch({}).impl));
    expect(res.candidates.map((c) => c.kind)).toEqual(['install-offer', 'paste-key']);
    const offer = res.candidates[0];
    if (offer?.kind !== 'install-offer') throw new Error('expected install-offer');
    expect(offer.plan.os).toBe('linux');
    expect(offer.model.modelId).toBe('qwen3'); // 16 GiB tier
  });

  it('honours an injected install plan and hasBrew', async () => {
    const mac = await probeKeyless({
      ...base(new InMemorySecretsResolver(), makeFetch({}).impl),
      platform: 'darwin',
      hasBrew: true,
    });
    const offer = mac.candidates[0];
    if (offer?.kind !== 'install-offer') throw new Error('expected install-offer');
    expect(offer.plan.command).toContain('brew install ollama');
  });

  it('probe never throws on fetch rejection, secrets failure or timeout', async () => {
    const secrets = new InMemorySecretsResolver();
    vi.spyOn(secrets, 'get').mockRejectedValue(new Error('vault down'));
    const rejecting = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const res = await probeKeyless(base(secrets, rejecting));
    expect(res.candidates.map((c) => c.kind)).toEqual(['install-offer', 'paste-key']);

    const timingOut = vi.fn(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    }) as unknown as typeof fetch;
    await expect(
      probeKeyless(base(new InMemorySecretsResolver(), timingOut)),
    ).resolves.toBeDefined();
  });
});
