import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { configParseNotices, ethosDir, parseConfigYaml, writeConfig } from '../index';

const base = 'provider: anthropic\nmodel: m\napiKey: k\n';

describe('plugins isolation config keys', () => {
  it('is absent when no key is set', () => {
    expect(parseConfigYaml(base).pluginIsolation).toBeUndefined();
  });

  it('parses every key', () => {
    const c = parseConfigYaml(
      `${base}plugins.isolation: host\nplugins.isolation.foo: in-process\nplugins.isolation.bar: host\n` +
        'plugins.host.sandbox: auto\nplugins.host.hook_timeout_ms: 500\n' +
        'plugins.host.idle_stop_minutes: 0\nplugins.host.max_heap_mb: 256\n',
    );
    expect(c.pluginIsolation).toEqual({
      default: 'host',
      overrides: { foo: 'in-process', bar: 'host' },
      sandbox: 'auto',
      hookTimeoutMs: 500,
      idleStopMinutes: 0,
      maxHeapMb: 256,
    });
    expect(configParseNotices(c).warnings).toEqual([]);
  });

  it('defaults the unset keys', () => {
    const c = parseConfigYaml(`${base}plugins.isolation.foo: host\n`);
    expect(c.pluginIsolation).toEqual({
      default: 'in-process',
      overrides: { foo: 'host' },
      sandbox: 'none',
      hookTimeoutMs: 2000,
      idleStopMinutes: 10,
      maxHeapMb: 512,
    });
  });

  it('invalid values warn and keep the default', () => {
    const c = parseConfigYaml(
      `${base}plugins.isolation: sandboxed\nplugins.isolation.foo: nope\nplugins.host.sandbox: yes\n` +
        'plugins.host.hook_timeout_ms: 99\nplugins.host.idle_stop_minutes: -1\nplugins.host.max_heap_mb: 63\n',
    );
    expect(c.pluginIsolation).toEqual({
      default: 'in-process',
      overrides: {},
      sandbox: 'none',
      hookTimeoutMs: 2000,
      idleStopMinutes: 10,
      maxHeapMb: 512,
    });
    const w = configParseNotices(c).warnings.filter((x) => x.includes('plugins.'));
    expect(w).toHaveLength(6);
  });

  it('round-trips through the writer', async () => {
    const c = parseConfigYaml(
      `${base}plugins.isolation: host\nplugins.isolation.foo: in-process\nplugins.host.max_heap_mb: 128\n`,
    );
    const storage = new InMemoryStorage();
    await writeConfig(storage, c, new InMemorySecretsResolver());
    const written = await storage.read(join(ethosDir(), 'config.yaml'));
    const again = parseConfigYaml(written ?? '');
    expect(again.pluginIsolation).toEqual(c.pluginIsolation);
  });
});

// "a catalog-community override to in-process is refused" is pinned in
// extensions/plugin-loader/src/__tests__/isolation-policy.test.ts.
