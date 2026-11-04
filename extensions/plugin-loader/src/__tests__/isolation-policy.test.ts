import { describe, expect, it } from 'vitest';
import { resolvePluginIsolation } from '../isolation-policy';

const hostDefault = { default: 'host' as const, overrides: {} };

describe('resolvePluginIsolation', () => {
  it('first-party @ethosagent/* from node_modules is always in-process', () => {
    const r = resolvePluginIsolation({
      pluginId: 'x',
      packageName: '@ethosagent/x',
      installLocation: 'node_modules',
      config: { default: 'host', overrides: { x: 'host' } },
    });
    expect(r).toEqual({ mode: 'in-process' });
  });

  it('an @ethosagent/* name under the plugins dir is NOT first-party', () => {
    const r = resolvePluginIsolation({
      pluginId: 'x',
      packageName: '@ethosagent/x',
      installLocation: 'plugins-dir',
      config: hostDefault,
    });
    expect(r.mode).toBe('host');
  });

  it('a catalog-community override to in-process is refused with a notice', () => {
    const r = resolvePluginIsolation({
      pluginId: 'c',
      packageName: 'c-plugin',
      installLocation: 'plugins-dir',
      catalogTier: 'community',
      config: { default: 'in-process', overrides: { c: 'in-process' } },
    });
    expect(r.mode).toBe('host');
    expect(r.notice).toContain('plugins.isolation.c');
  });

  it('catalog community is host even with default in-process and no config', () => {
    const r = resolvePluginIsolation({
      pluginId: 'c',
      packageName: 'c-plugin',
      installLocation: 'plugins-dir',
      catalogTier: 'community',
    });
    expect(r).toEqual({ mode: 'host' });
  });

  it('others: per-plugin override beats the default', () => {
    const base = { pluginId: 'p', packageName: 'p', installLocation: 'local-dir' as const };
    expect(resolvePluginIsolation({ ...base, config: hostDefault }).mode).toBe('host');
    expect(
      resolvePluginIsolation({
        ...base,
        config: { default: 'host', overrides: { p: 'in-process' } },
      }).mode,
    ).toBe('in-process');
    expect(resolvePluginIsolation(base).mode).toBe('in-process');
  });
});
