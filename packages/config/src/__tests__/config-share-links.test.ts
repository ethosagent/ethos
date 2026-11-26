// `shareLinks.enabled` / `shareLinks.excludePersonalities` — the global operator
// switch for share links (plan share-links D11). Same posture as `idleWatcher`:
// a strict boolean (only a literal true/false; anything else is dropped with a
// warning so a typo never turns publishing on), and an unknown `shareLinks.*` key
// gets the softer `'shareLinks.foo' has no effect` notice (known-keys.ts), not the
// unknown-key one.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  configParseNotices,
  ethosDir,
  parseConfigYaml,
  readRawConfig,
  resolveShareLinks,
  writeConfig,
} from '../index';

const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];
const parse = (...lines: string[]) => parseConfigYaml([...base, ...lines].join('\n'));
const warningsOf = (...lines: string[]) => configParseNotices(parse(...lines)).warnings;

describe('shareLinks config block', () => {
  it('parses both keys', () => {
    const cfg = parse('shareLinks.enabled: true', 'shareLinks.excludePersonalities: ops, legal');
    expect(cfg.shareLinks).toEqual({ enabled: true, excludePersonalities: ['ops', 'legal'] });
  });

  it('defaults to off with an empty list when absent', () => {
    const cfg = parse();
    expect(cfg.shareLinks).toBeUndefined();
    expect(resolveShareLinks(cfg)).toEqual({ enabled: false, excludePersonalities: [] });
  });

  it('accepts an explicit false', () => {
    expect(resolveShareLinks(parse('shareLinks.enabled: false')).enabled).toBe(false);
  });

  it('drops a non-boolean enabled with a warning and stays off', () => {
    for (const bad of ['yes', 'on', '1', 'TRUE', 'garbage']) {
      const cfg = parse(`shareLinks.enabled: ${bad}`);
      expect(resolveShareLinks(cfg).enabled).toBe(false);
      expect(warningsOf(`shareLinks.enabled: ${bad}`).join('\n')).toContain('shareLinks.enabled');
    }
  });

  it('trims the list and drops empty items', () => {
    const cfg = parse('shareLinks.excludePersonalities:  a ,, b , ,c ');
    expect(cfg.shareLinks?.excludePersonalities).toEqual(['a', 'b', 'c']);
  });

  it('drops ids with invalid characters, with a warning, keeping the valid ones', () => {
    const lines = ['shareLinks.excludePersonalities: ok, ../etc, Bad Id, fine_2'];
    expect(parse(...lines).shareLinks?.excludePersonalities).toEqual(['ok', 'fine_2']);
    const warnings = warningsOf(...lines).join('\n');
    expect(warnings).toContain('../etc');
    expect(warnings).toContain('Bad Id');
  });

  it('an unknown shareLinks.* key is handled like any known family (`has no effect` notice, no unknown-key notice, preserved on write)', async () => {
    // Same as idleWatcher.*: the `shareLinks.` prefix is a known family (known-keys.ts), so a
    // field the parser does not model is kept verbatim by writeConfig and gets the
    // `has no effect` notice only.
    expect(
      warningsOf('shareLinks.foo: 1').some((w) => w.includes("'shareLinks.foo' has no effect")),
    ).toBe(true);
    expect(warningsOf('shareLinks.foo: 1').filter((w) => w.includes('unknown key'))).toEqual([]);
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [...base, 'shareLinks.enabled: true', 'shareLinks.foo: 1'].join('\n'),
    );
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config missing');
    await writeConfig(storage, cfg, new InMemorySecretsResolver());
    expect(await storage.read(join(ethosDir(), 'config.yaml'))).toContain('shareLinks.foo: 1');
  });

  it('round-trips through writeConfig losslessly', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [...base, 'shareLinks.enabled: true', 'shareLinks.excludePersonalities: a, b'].join('\n'),
    );
    const first = await readRawConfig(storage);
    if (!first) throw new Error('config missing');
    await writeConfig(storage, first, new InMemorySecretsResolver());
    const src = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(src).toContain('shareLinks.enabled: true');
    expect(src).toContain('shareLinks.excludePersonalities: a,b');
    const second = await readRawConfig(storage);
    expect(second?.shareLinks).toEqual({ enabled: true, excludePersonalities: ['a', 'b'] });
    expect(configParseNotices(parseConfigYaml(src ?? '')).warnings).toEqual([]);
  });

  it('writes nothing when unset', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), base.join('\n'));
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config missing');
    await writeConfig(storage, cfg, new InMemorySecretsResolver());
    expect(await storage.read(join(ethosDir(), 'config.yaml'))).not.toContain('shareLinks');
  });
});
