import type { SecretsResolver } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvSecretsResolver, MergedSecretsResolver } from '../env-secrets';
import { InMemorySecretsResolver } from '../secrets';

// ---------------------------------------------------------------------------
// Helpers: save/restore process.env
// ---------------------------------------------------------------------------

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Clear ANTHROPIC_API_KEY so tests start predictably
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

// ---------------------------------------------------------------------------
// MergedSecretsResolver tests
// ---------------------------------------------------------------------------

describe('MergedSecretsResolver', () => {
  it('env value wins over file value for same ref', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-key';
    const file = new InMemorySecretsResolver();
    await file.set('providers/anthropic/apiKey', 'file-key');
    const merged = new MergedSecretsResolver({
      readers: [new EnvSecretsResolver(), file],
      writer: file,
    });
    expect(await merged.get('providers/anthropic/apiKey')).toBe('env-key');
  });

  it('falls back to file when env var is not set', async () => {
    const file = new InMemorySecretsResolver();
    await file.set('providers/anthropic/apiKey', 'file-key');
    const merged = new MergedSecretsResolver({
      readers: [new EnvSecretsResolver(), file],
      writer: file,
    });
    expect(await merged.get('providers/anthropic/apiKey')).toBe('file-key');
  });

  it('returns null when neither env nor file has the ref', async () => {
    const file = new InMemorySecretsResolver();
    const merged = new MergedSecretsResolver({
      readers: [new EnvSecretsResolver(), file],
      writer: file,
    });
    expect(await merged.get('providers/anthropic/apiKey')).toBeNull();
  });

  it('process.env only (no file) works', async () => {
    process.env.OPENAI_API_KEY = 'sk-oai-from-env';
    const file = new InMemorySecretsResolver();
    const merged = new MergedSecretsResolver({
      readers: [new EnvSecretsResolver(), file],
      writer: file,
    });
    expect(await merged.get('providers/openai/apiKey')).toBe('sk-oai-from-env');
  });

  it('only file on disk, no env → file value used', async () => {
    const file = new InMemorySecretsResolver();
    await file.set('providers/groq/apiKey', 'groq-file-key');
    const merged = new MergedSecretsResolver({
      readers: [new EnvSecretsResolver(), file],
      writer: file,
    });
    expect(await merged.get('providers/groq/apiKey')).toBe('groq-file-key');
  });

  it('set delegates to file resolver', async () => {
    const file = new InMemorySecretsResolver();
    const merged = new MergedSecretsResolver({
      readers: [new EnvSecretsResolver(), file],
      writer: file,
    });
    await merged.set('providers/anthropic/apiKey', 'stored');
    expect(await file.get('providers/anthropic/apiKey')).toBe('stored');
  });

  it('delete delegates to file resolver', async () => {
    const file = new InMemorySecretsResolver();
    await file.set('providers/anthropic/apiKey', 'to-delete');
    const merged = new MergedSecretsResolver({
      readers: [new EnvSecretsResolver(), file],
      writer: file,
    });
    await merged.delete('providers/anthropic/apiKey');
    expect(await file.get('providers/anthropic/apiKey')).toBeNull();
  });

  it('list returns union of env and file refs', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-val';
    const file = new InMemorySecretsResolver();
    await file.set('providers/openai/apiKey', 'file-val');
    const merged = new MergedSecretsResolver({
      readers: [new EnvSecretsResolver(), file],
      writer: file,
    });
    const refs = await merged.list();
    expect(refs).toContain('providers/anthropic/apiKey');
    expect(refs).toContain('providers/openai/apiKey');
  });

  it('list deduplicates refs present in both env and file', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-val';
    const file = new InMemorySecretsResolver();
    await file.set('providers/anthropic/apiKey', 'file-val');
    const merged = new MergedSecretsResolver({
      readers: [new EnvSecretsResolver(), file],
      writer: file,
    });
    const refs = await merged.list();
    const count = refs.filter((r) => r === 'providers/anthropic/apiKey').length;
    expect(count).toBe(1);
  });

  it('list filters by prefix', async () => {
    process.env.ANTHROPIC_API_KEY = 'val';
    const file = new InMemorySecretsResolver();
    await file.set('channels/telegram/default/botToken', 'tok');
    const merged = new MergedSecretsResolver({
      readers: [new EnvSecretsResolver(), file],
      writer: file,
    });
    const refs = await merged.list('providers/');
    expect(refs).toContain('providers/anthropic/apiKey');
    for (const ref of refs) {
      expect(ref.startsWith('providers/')).toBe(true);
    }
  });

  it('accepts two InMemorySecretsResolvers (interface-typed params)', async () => {
    // Confirms MergedSecretsResolver accepts SecretsResolver interface, not concrete types
    const env = new InMemorySecretsResolver();
    const file = new InMemorySecretsResolver();
    await env.set('some/ref', 'env-wins');
    await file.set('some/ref', 'file-val');
    const merged = new MergedSecretsResolver({ readers: [env, file], writer: file });
    expect(await merged.get('some/ref')).toBe('env-wins');
  });

  it('3-resolver chain: first reader wins, writer is independent', async () => {
    const env = new InMemorySecretsResolver();
    const aws = new InMemorySecretsResolver();
    const file = new InMemorySecretsResolver();

    await env.set('providers/anthropic/apiKey', 'env-value');
    await aws.set('providers/anthropic/apiKey', 'aws-value');
    await file.set('providers/anthropic/apiKey', 'file-value');

    const merged = new MergedSecretsResolver({ readers: [env, aws, file], writer: file });

    // env wins over aws and file
    expect(await merged.get('providers/anthropic/apiKey')).toBe('env-value');
  });

  it('AWS resolver shadows file when env is empty', async () => {
    const env = new InMemorySecretsResolver();
    const aws = new InMemorySecretsResolver();
    const file = new InMemorySecretsResolver();

    await aws.set('providers/anthropic/apiKey', 'aws-value');
    await file.set('providers/anthropic/apiKey', 'file-value');

    const merged = new MergedSecretsResolver({ readers: [env, aws, file], writer: file });

    expect(await merged.get('providers/anthropic/apiKey')).toBe('aws-value');
  });

  it('file fallback when AWS has no value', async () => {
    const env = new InMemorySecretsResolver();
    const aws = new InMemorySecretsResolver();
    const file = new InMemorySecretsResolver();

    await file.set('providers/anthropic/apiKey', 'file-value');

    const merged = new MergedSecretsResolver({ readers: [env, aws, file], writer: file });

    expect(await merged.get('providers/anthropic/apiKey')).toBe('file-value');
  });

  it('N-resolver generalization: 4 resolvers, first non-null wins', async () => {
    const a = new InMemorySecretsResolver();
    const b = new InMemorySecretsResolver();
    const c = new InMemorySecretsResolver();
    const d = new InMemorySecretsResolver();

    await c.set('some/ref', 'c-value');
    await d.set('some/ref', 'd-value');

    const merged = new MergedSecretsResolver({ readers: [a, b, c, d], writer: d });

    expect(await merged.get('some/ref')).toBe('c-value');
  });

  it('set delegates to the explicit writer, not readers', async () => {
    const env = new InMemorySecretsResolver();
    const aws = new InMemorySecretsResolver();
    const file = new InMemorySecretsResolver();

    const merged = new MergedSecretsResolver({ readers: [env, aws, file], writer: file });
    await merged.set('some/ref', 'written-value');

    // Value is in file (the writer), not in env or aws
    expect(await file.get('some/ref')).toBe('written-value');
    expect(await env.get('some/ref')).toBeNull();
    expect(await aws.get('some/ref')).toBeNull();
  });

  it('list only includes refs from readers', async () => {
    const env = new InMemorySecretsResolver();
    const file = new InMemorySecretsResolver();

    await env.set('a/ref', 'val');
    await file.set('b/ref', 'val');

    const merged = new MergedSecretsResolver({ readers: [env], writer: file });
    const refs = await merged.list();

    expect(refs).toContain('a/ref');
    expect(refs).not.toContain('b/ref');
  });

  it('list includes writer refs when writer is also a reader', async () => {
    const env = new InMemorySecretsResolver();
    const file = new InMemorySecretsResolver();

    await env.set('a/ref', 'val');
    await file.set('b/ref', 'val');

    const merged = new MergedSecretsResolver({ readers: [env, file], writer: file });
    const refs = await merged.list();

    expect(refs).toContain('a/ref');
    expect(refs).toContain('b/ref');
  });

  it('reader error propagates instead of being swallowed', async () => {
    const failing: SecretsResolver = {
      get: async () => {
        throw new Error('AWS network timeout');
      },
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };
    const file = new InMemorySecretsResolver();
    await file.set('some/ref', 'file-value');

    const merged = new MergedSecretsResolver({
      readers: [failing, file],
      writer: file,
    });

    await expect(merged.get('some/ref')).rejects.toThrow('AWS network timeout');
  });

  it('reader returning null falls through to next reader', async () => {
    const empty: SecretsResolver = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };
    const file = new InMemorySecretsResolver();
    await file.set('some/ref', 'file-value');

    const merged = new MergedSecretsResolver({
      readers: [empty, file],
      writer: file,
    });

    expect(await merged.get('some/ref')).toBe('file-value');
  });

  it('Phase 1 regression: writes go to file writer, not to write-capable AWS reader', async () => {
    const env = new InMemorySecretsResolver();
    const aws = new InMemorySecretsResolver();
    const file = new InMemorySecretsResolver();

    const merged = new MergedSecretsResolver({
      readers: [env, aws, file],
      writer: file,
    });
    await merged.set('test/key', 'value');

    expect(await file.get('test/key')).toBe('value');
    expect(await aws.get('test/key')).toBeNull();
    expect(await env.get('test/key')).toBeNull();
  });

  it('writer flip: when writer is AWS, set() routes to AWS not file', async () => {
    const env = new InMemorySecretsResolver();
    const aws = new InMemorySecretsResolver();
    const file = new InMemorySecretsResolver();

    const merged = new MergedSecretsResolver({
      readers: [env, aws, file],
      writer: aws,
    });
    await merged.set('mcp/server/access_token', 'token-value');

    expect(await aws.get('mcp/server/access_token')).toBe('token-value');
    expect(await file.get('mcp/server/access_token')).toBeNull();
  });

  it('writer flip: when writer is AWS, delete() routes to AWS not file', async () => {
    const env = new InMemorySecretsResolver();
    const aws = new InMemorySecretsResolver();
    const file = new InMemorySecretsResolver();

    await aws.set('mcp/server/access_token', 'to-delete');

    const merged = new MergedSecretsResolver({
      readers: [env, aws, file],
      writer: aws,
    });
    await merged.delete('mcp/server/access_token');

    expect(await aws.get('mcp/server/access_token')).toBeNull();
  });

  it('writer flip: file remains readable as fallback when writer is AWS', async () => {
    const env = new InMemorySecretsResolver();
    const aws = new InMemorySecretsResolver();
    const file = new InMemorySecretsResolver();

    await file.set('some/ref', 'file-value');

    const merged = new MergedSecretsResolver({
      readers: [env, aws, file],
      writer: aws,
    });

    expect(await merged.get('some/ref')).toBe('file-value');
  });

  it('write failure propagates — no silent fallback to file', async () => {
    const env = new InMemorySecretsResolver();
    const file = new InMemorySecretsResolver();
    const failing: SecretsResolver = {
      get: async () => null,
      set: async () => {
        throw new Error('AccessDeniedException');
      },
      delete: async () => {
        throw new Error('AccessDeniedException');
      },
      list: async () => [],
    };

    const merged = new MergedSecretsResolver({
      readers: [env, file],
      writer: failing,
    });

    await expect(merged.set('test/key', 'val')).rejects.toThrow('AccessDeniedException');
    expect(await file.get('test/key')).toBeNull();
  });
});
