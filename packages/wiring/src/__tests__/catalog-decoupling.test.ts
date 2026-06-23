import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('catalog decoupling invariant', () => {
  const root = join(import.meta.dirname, '..', '..', '..', '..');

  it('register-builtin-providers does not import model-catalog', async () => {
    const src = await readFile(
      join(root, 'packages/wiring/src/register-builtin-providers.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/from\s+['"].*model-catalog/);
    expect(src).not.toMatch(/import\s*\{[^}]*MODEL_CATALOG/);
    expect(src).not.toMatch(/import\s*\{[^}]*PROVIDER_CATALOG/);
  });

  it('core agent-loop does not import model-catalog', async () => {
    const src = await readFile(join(root, 'packages/core/src/agent-loop.ts'), 'utf8');
    expect(src).not.toMatch(/from\s+['"].*model-catalog/);
    expect(src).not.toMatch(/import\s*\{[^}]*MODEL_CATALOG/);
  });

  it('chained-provider does not import model-catalog', async () => {
    const src = await readFile(
      join(root, 'packages/core/src/providers/chained-provider.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/from\s+['"].*model-catalog/);
    expect(src).not.toMatch(/import\s*\{[^}]*MODEL_CATALOG/);
  });

  it('provider factories resolve any model without catalog lookup', async () => {
    const { DefaultLLMProviderRegistry } = await import('@ethosagent/core');
    const { registerBuiltinProviders } = await import('../register-builtin-providers');
    const registry = new DefaultLLMProviderRegistry();
    registerBuiltinProviders(registry);

    const factory = registry.get('openai-compat');
    expect(factory).toBeDefined();

    const secrets = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      // biome-ignore lint/suspicious/noExplicitAny: recursive logger mock
      child: () => logger as any,
    };

    // Use a made-up model that is definitely not in any catalog
    const provider = await factory?.({
      config: { model: 'totally-custom-model-xyz-123', apiKey: 'test-key' },
      secrets,
      logger,
    });
    expect(provider).toBeDefined();
    expect(provider?.model).toBe('totally-custom-model-xyz-123');
  });
});
