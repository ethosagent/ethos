import { join } from 'node:path';
import { parseConfigYaml } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  mergeOnboardingIntoConfig,
  readSharedModelSettings,
  resolveDesktopModelSettings,
} from '../desktop-config';

// Builds a literal `${secrets:<path>}` ref via concatenation so biome's
// noTemplateCurlyInString rule does not flag the config placeholder syntax.
function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

const dir = '/data/ethos';

async function withConfig(lines: string[]) {
  const storage = new InMemoryStorage();
  const secrets = new InMemorySecretsResolver();
  await storage.mkdir(dir);
  await storage.write(join(dir, 'config.yaml'), lines.join('\n'));
  return { storage, secrets };
}

// The desktop backend's provider/model/personality come from config.yaml —
// the file the SPA's onboarding writes and the web header reads — not from
// the Electron store, which nothing in the SPA writes.
describe('readSharedModelSettings', () => {
  it('reads provider, model and personality from config.yaml', async () => {
    const { storage, secrets } = await withConfig([
      'schemaVersion: 1',
      'provider: codex',
      'model: gpt-5.6-luna',
      'personality: engineer',
    ]);

    const result = await readSharedModelSettings(storage, secrets, dir);

    expect(result).toEqual({ provider: 'codex', model: 'gpt-5.6-luna', personality: 'engineer' });
  });

  it('returns {} when config.yaml does not exist', async () => {
    const result = await readSharedModelSettings(
      new InMemoryStorage(),
      new InMemorySecretsResolver(),
      dir,
    );

    expect(result).toEqual({});
  });

  it('leaves out a key the file does not set, so the store/default fallback applies', async () => {
    const { storage, secrets } = await withConfig(['provider: openai']);

    const result = await readSharedModelSettings(storage, secrets, dir);

    expect(result).toEqual({ provider: 'openai' });
  });

  it('resolves a secrets-ref apiKey through the secrets resolver', async () => {
    const { storage, secrets } = await withConfig([
      'provider: anthropic',
      'model: claude-opus-5-5',
      `apiKey: ${secretRef('api-key')}`,
      'baseUrl: https://proxy.example.com',
    ]);
    await secrets.set('api-key', 'sk-from-vault');

    const result = await readSharedModelSettings(storage, secrets, dir);

    expect(result.apiKey).toBe('sk-from-vault');
    expect(result.baseUrl).toBe('https://proxy.example.com');
  });
});

describe('resolveDesktopModelSettings', () => {
  it('a config.yaml value beats the Electron store value', () => {
    const result = resolveDesktopModelSettings(
      { provider: 'codex', model: 'gpt-5.6-luna', personality: 'engineer', apiKey: 'sk-config' },
      { provider: 'anthropic', model: 'claude-opus-5-5', personality: 'operator' },
      'sk-keychain',
    );

    expect(result).toEqual({
      provider: 'codex',
      model: 'gpt-5.6-luna',
      personality: 'engineer',
      apiKey: 'sk-config',
    });
  });

  it('falls back to the store, then the keychain, per field', () => {
    const result = resolveDesktopModelSettings(
      { provider: 'codex' },
      { model: 'gpt-5.5', personality: 'coach', baseUrl: 'https://store.example.com' },
      'sk-keychain',
    );

    expect(result).toEqual({
      provider: 'codex',
      model: 'gpt-5.5',
      personality: 'coach',
      apiKey: 'sk-keychain',
      baseUrl: 'https://store.example.com',
    });
  });

  it('falls back to the existing defaults when neither source sets a field', () => {
    const result = resolveDesktopModelSettings({}, {}, null);

    expect(result.provider).toBe('anthropic');
    expect(result.model).toMatch(/^claude-/);
    expect(result.personality).toBe('operator');
    expect(result.apiKey).toBe('');
    expect(result.baseUrl).toBeUndefined();
  });
});

describe('mergeOnboardingIntoConfig', () => {
  it('keeps every other key in an existing config.yaml', async () => {
    const { storage } = await withConfig([
      '# my settings',
      'provider: anthropic',
      'model: claude-opus-5-5',
      'personality: operator',
      'nodes.enabled: true',
      'telegram.bots.0.personality: operator',
    ]);

    await mergeOnboardingIntoConfig(
      { storage, dataDir: dir },
      { provider: 'codex', model: 'gpt-5.6-luna', personality: 'engineer', apiKeyRef: false },
    );

    const src = (await storage.read(join(dir, 'config.yaml'))) ?? '';
    const parsed = parseConfigYaml(src);
    expect(parsed.provider).toBe('codex');
    expect(parsed.model).toBe('gpt-5.6-luna');
    expect(parsed.personality).toBe('engineer');
    expect(src).toContain('nodes.enabled: true');
    expect(src).toContain('telegram.bots.0.personality: operator');
    expect(src).toContain('# my settings');
  });

  it('creates a missing config.yaml with the keys the onboarding wrote before', async () => {
    const storage = new InMemoryStorage();

    await mergeOnboardingIntoConfig(
      { storage, dataDir: dir },
      { provider: 'anthropic', model: 'claude-opus-5-5', personality: 'engineer', apiKeyRef: true },
    );

    const src = (await storage.read(join(dir, 'config.yaml'))) ?? '';
    const parsed = parseConfigYaml(src);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.provider).toBe('anthropic');
    expect(parsed.model).toBe('claude-opus-5-5');
    expect(parsed.personality).toBe('engineer');
    expect(parsed.apiKey).toBe(secretRef('api-key'));
    expect(src.trim().split('\n')).toHaveLength(5);
  });
});
