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
    const merged = new MergedSecretsResolver(new EnvSecretsResolver(), file);
    expect(await merged.get('providers/anthropic/apiKey')).toBe('env-key');
  });

  it('falls back to file when env var is not set', async () => {
    const file = new InMemorySecretsResolver();
    await file.set('providers/anthropic/apiKey', 'file-key');
    const merged = new MergedSecretsResolver(new EnvSecretsResolver(), file);
    expect(await merged.get('providers/anthropic/apiKey')).toBe('file-key');
  });

  it('returns null when neither env nor file has the ref', async () => {
    const file = new InMemorySecretsResolver();
    const merged = new MergedSecretsResolver(new EnvSecretsResolver(), file);
    expect(await merged.get('providers/anthropic/apiKey')).toBeNull();
  });

  it('process.env only (no file) works', async () => {
    process.env.OPENAI_API_KEY = 'sk-oai-from-env';
    const file = new InMemorySecretsResolver();
    const merged = new MergedSecretsResolver(new EnvSecretsResolver(), file);
    expect(await merged.get('providers/openai/apiKey')).toBe('sk-oai-from-env');
  });

  it('only file on disk, no env → file value used', async () => {
    const file = new InMemorySecretsResolver();
    await file.set('providers/groq/apiKey', 'groq-file-key');
    const merged = new MergedSecretsResolver(new EnvSecretsResolver(), file);
    expect(await merged.get('providers/groq/apiKey')).toBe('groq-file-key');
  });

  it('set delegates to file resolver', async () => {
    const file = new InMemorySecretsResolver();
    const merged = new MergedSecretsResolver(new EnvSecretsResolver(), file);
    await merged.set('providers/anthropic/apiKey', 'stored');
    expect(await file.get('providers/anthropic/apiKey')).toBe('stored');
  });

  it('delete delegates to file resolver', async () => {
    const file = new InMemorySecretsResolver();
    await file.set('providers/anthropic/apiKey', 'to-delete');
    const merged = new MergedSecretsResolver(new EnvSecretsResolver(), file);
    await merged.delete('providers/anthropic/apiKey');
    expect(await file.get('providers/anthropic/apiKey')).toBeNull();
  });

  it('list returns union of env and file refs', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-val';
    const file = new InMemorySecretsResolver();
    await file.set('providers/openai/apiKey', 'file-val');
    const merged = new MergedSecretsResolver(new EnvSecretsResolver(), file);
    const refs = await merged.list();
    expect(refs).toContain('providers/anthropic/apiKey');
    expect(refs).toContain('providers/openai/apiKey');
  });

  it('list deduplicates refs present in both env and file', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-val';
    const file = new InMemorySecretsResolver();
    await file.set('providers/anthropic/apiKey', 'file-val');
    const merged = new MergedSecretsResolver(new EnvSecretsResolver(), file);
    const refs = await merged.list();
    const count = refs.filter((r) => r === 'providers/anthropic/apiKey').length;
    expect(count).toBe(1);
  });

  it('list filters by prefix', async () => {
    process.env.ANTHROPIC_API_KEY = 'val';
    const file = new InMemorySecretsResolver();
    await file.set('channels/telegram/default/botToken', 'tok');
    const merged = new MergedSecretsResolver(new EnvSecretsResolver(), file);
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
    const merged = new MergedSecretsResolver(env, file);
    expect(await merged.get('some/ref')).toBe('env-wins');
  });
});
