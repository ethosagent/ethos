// Plan ux-feedback-and-config-clarity B3 (§6.2–6.3) + UD1 Option A: one
// resolver answers "which configuration is in effect", and a personality-typed
// `activeContext` on disk is migrated into `personality:` on load.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it, vi } from 'vitest';
import {
  configParseNotices,
  type EthosConfig,
  ethosDir,
  parseConfigYaml,
  readRawConfig,
  resolveEffectiveConfig,
} from '../index';

const BASE: EthosConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  apiKey: '',
  personality: 'reviewer',
};

describe('resolveEffectiveConfig — personality', () => {
  it('reports the personality: key as the source', () => {
    const resolved = resolveEffectiveConfig(BASE, {});
    expect(resolved.personality).toEqual({ id: 'reviewer', source: 'personality' });
  });

  it('names the shadowed key when an in-process activeContext outranks it', () => {
    const resolved = resolveEffectiveConfig(
      { ...BASE, activeContext: { type: 'personality', name: 'engineer' } },
      {},
    );
    expect(resolved.personality).toEqual({
      id: 'engineer',
      source: 'activeContext',
      shadowed: 'reviewer',
    });
  });

  it('a team activeContext does not shadow the personality key', () => {
    const resolved = resolveEffectiveConfig(
      { ...BASE, activeContext: { type: 'team', name: 'eng' } },
      {},
    );
    expect(resolved.personality).toEqual({ id: 'reviewer', source: 'personality' });
  });

  it('falls back to the parser default when neither key is set', () => {
    const resolved = resolveEffectiveConfig({ ...BASE, personality: '' }, {});
    expect(resolved.personality).toEqual({ id: 'researcher', source: 'default' });
  });

  // B3 honesty — parseConfigYaml bakes DEFAULT_PERSONALITY_ID into the field,
  // so key ABSENCE is recorded in a parse-time side-table; a file that never
  // set `personality:` must report `(default)`, not `(personality:)`.
  it('a parsed config whose file never set personality: reports source default', () => {
    const cfg = parseConfigYaml(
      ['provider: anthropic', 'model: claude-sonnet-5', 'apiKey: sk'].join('\n'),
    );
    expect(cfg.personality).toBe('researcher'); // the parser still bakes the id in
    expect(resolveEffectiveConfig(cfg, {}).personality).toEqual({
      id: 'researcher',
      source: 'default',
    });
  });

  it('a parsed config whose file set personality: reports the key as the source', () => {
    const cfg = parseConfigYaml(
      ['provider: anthropic', 'model: claude-sonnet-5', 'apiKey: sk', 'personality: coder'].join(
        '\n',
      ),
    );
    expect(resolveEffectiveConfig(cfg, {}).personality).toEqual({
      id: 'coder',
      source: 'personality',
    });
  });
});

describe('resolveEffectiveConfig — state dir and model rung', () => {
  it('honours ETHOS_STATE_DIR from the env it was given', () => {
    const resolved = resolveEffectiveConfig(BASE, { ETHOS_STATE_DIR: '/tmp/ethos-profile' });
    expect(resolved.stateDir).toBe('/tmp/ethos-profile');
    expect(resolved.configPath).toBe(join('/tmp/ethos-profile', 'config.yaml'));
    const home = resolveEffectiveConfig(BASE, {});
    expect(home.stateDir).toBe(join(homedir(), '.ethos'));
  });

  it('reports the modelRouting rung for the effective personality', () => {
    const resolved = resolveEffectiveConfig(
      { ...BASE, modelRouting: { reviewer: 'claude-haiku-4' } },
      {},
    );
    expect(resolved.model).toEqual({ id: 'claude-haiku-4', rung: 'modelRouting.reviewer' });
  });

  it('falls back to the global model: key', () => {
    const resolved = resolveEffectiveConfig(BASE, {});
    expect(resolved.model).toEqual({ id: 'claude-sonnet-5', rung: 'model:' });
  });
});

describe('resolveEffectiveConfig — api key source', () => {
  it('reports env, and that it overrides the vault when the vault holds the ref too', () => {
    const resolved = resolveEffectiveConfig(
      BASE,
      { ANTHROPIC_API_KEY: 'sk-env' },
      {
        vaultRefs: ['providers/anthropic/apiKey'],
      },
    );
    expect(resolved.apiKey).toEqual({
      provider: 'anthropic',
      source: 'env',
      ref: 'providers/anthropic/apiKey',
      envVar: 'ANTHROPIC_API_KEY',
      overrides: 'vault',
    });
  });

  it('claims no override without the vault listing', () => {
    const resolved = resolveEffectiveConfig(BASE, { ANTHROPIC_API_KEY: 'sk-env' });
    expect(resolved.apiKey.source).toBe('env');
    expect(resolved.apiKey.overrides).toBeUndefined();
  });

  it('reports vault (unverified) when no env var supplies the ref and no listing was given', () => {
    const resolved = resolveEffectiveConfig(BASE, {});
    expect(resolved.apiKey).toEqual({
      provider: 'anthropic',
      source: 'vault',
      ref: 'providers/anthropic/apiKey',
    });
  });

  // B3 honesty — `vault` is only claimed when it could be true. With a vault
  // listing in hand, an env miss on a ref the vault does not hold is
  // `missing`, never an unverified `vault` claim.
  it('reports missing when env is unset and the provided vault listing lacks the ref', () => {
    const resolved = resolveEffectiveConfig(BASE, {}, { vaultRefs: [] });
    expect(resolved.apiKey).toEqual({
      provider: 'anthropic',
      source: 'missing',
      ref: 'providers/anthropic/apiKey',
    });
  });

  it('keeps the vault verdict when the provided listing holds the ref', () => {
    const resolved = resolveEffectiveConfig(
      BASE,
      {},
      { vaultRefs: ['providers/anthropic/apiKey'] },
    );
    expect(resolved.apiKey).toEqual({
      provider: 'anthropic',
      source: 'vault',
      ref: 'providers/anthropic/apiKey',
    });
  });

  it('reports an inline plaintext key as inline', () => {
    const resolved = resolveEffectiveConfig({ ...BASE, apiKey: 'sk-plaintext' }, {});
    expect(resolved.apiKey).toEqual({ provider: 'anthropic', source: 'inline' });
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ref, not a template
  it('follows an explicit ${secrets:…} ref in apiKey', () => {
    const resolved = resolveEffectiveConfig(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ref, not a template
      { ...BASE, apiKey: '${secrets:providers/openai/apiKey}' },
      { OPENAI_API_KEY: 'sk-env' },
    );
    expect(resolved.apiKey.source).toBe('env');
    expect(resolved.apiKey.envVar).toBe('OPENAI_API_KEY');
  });
});

describe('UD1 Option A — activeContext personality migration on load', () => {
  const FILE = [
    '# my config',
    'schemaVersion: 1',
    'provider: anthropic',
    'model: claude-sonnet-5',
    '# the fallback key, shadowed until this release',
    'personality: reviewer',
    'activeContext.type: personality',
    'activeContext.name: engineer',
    'skin: mono',
  ];

  async function seed(lines: readonly string[]): Promise<InMemoryStorage> {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), `${lines.join('\n')}\n`);
    return storage;
  }

  it('folds the entry into personality:, rewrites the file once, and warns for one release', async () => {
    const storage = await seed(FILE);
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config did not parse');

    // In memory: the legacy read path yields the same id post-migration.
    expect(cfg.activeContext).toBeUndefined();
    expect(cfg.activeContext?.name ?? cfg.personality).toBe('engineer');
    const warnings = configParseNotices(cfg).warnings;
    expect(warnings.some((w) => w.includes('activeContext.type: personality is deprecated'))).toBe(
      true,
    );

    // On disk: a surgical rewrite — comments and unrelated lines untouched.
    const src = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(src).not.toContain('activeContext.');
    expect(src).toContain('personality: engineer');
    expect(src).toContain('# my config');
    expect(src).toContain('# the fallback key, shadowed until this release');
    expect(src).toContain('skin: mono');

    // Second load: nothing left to migrate, no deprecation.
    const cfg2 = await readRawConfig(storage);
    if (!cfg2) throw new Error('rewritten config did not parse');
    expect(cfg2.personality).toBe('engineer');
    expect(configParseNotices(cfg2).warnings.some((w) => w.includes('activeContext.type'))).toBe(
      false,
    );
    expect(resolveEffectiveConfig(cfg2, {}).personality).toEqual({
      id: 'engineer',
      source: 'personality',
    });
  });

  it('inserts a personality: line when the file had none', async () => {
    const storage = await seed([
      'schemaVersion: 1',
      'provider: anthropic',
      'model: claude-sonnet-5',
      'activeContext.type: personality',
      'activeContext.name: engineer',
    ]);
    const cfg = await readRawConfig(storage);
    expect(cfg?.personality).toBe('engineer');
    const src = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(src).toContain('personality: engineer');
    expect(src).not.toContain('activeContext.');
  });

  it('rewrites the file with writeAtomic (storage contract for config.yaml)', async () => {
    // The failure case below completes the pin: with writeAtomic mocked to
    // throw, a direct storage.write would still rewrite the file and that
    // test would fail — so together they prove the rewrite goes through
    // writeAtomic alone.
    const storage = await seed(FILE);
    const atomic = vi.spyOn(storage, 'writeAtomic');
    await readRawConfig(storage);
    expect(atomic).toHaveBeenCalledWith(
      join(ethosDir(), 'config.yaml'),
      expect.stringContaining('personality: engineer'),
      { mode: 0o600 },
    );
  });

  it('a rewrite that throws warns honestly: not rewritten, retried on the next load', async () => {
    const storage = await seed(FILE);
    vi.spyOn(storage, 'writeAtomic').mockRejectedValue(new Error('EROFS: read-only'));
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config did not parse');

    // The in-memory migration still holds for this process.
    expect(cfg.personality).toBe('engineer');
    expect(cfg.activeContext).toBeUndefined();

    // The notice states the failure — never "rewritten automatically".
    const warning = configParseNotices(cfg).warnings.find((w) =>
      w.includes('activeContext.type: personality is deprecated'),
    );
    expect(warning).toContain('could not be rewritten (EROFS: read-only)');
    expect(warning).toContain('retried on the next load');
    expect(warning).not.toContain('no action needed');

    // The file is untouched, so the next load repeats the attempt.
    const src = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(src).toContain('activeContext.type: personality');
  });

  it('leaves a team activeContext alone', async () => {
    const lines = [
      'schemaVersion: 1',
      'provider: anthropic',
      'model: claude-sonnet-5',
      'personality: reviewer',
      'activeContext.type: team',
      'activeContext.name: eng',
    ];
    const storage = await seed(lines);
    const cfg = await readRawConfig(storage);
    expect(cfg?.activeContext).toEqual({ type: 'team', name: 'eng' });
    const src = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(src).toBe(`${lines.join('\n')}\n`);
  });

  it('parseConfigYaml alone (no storage) still accepts the legacy lines', () => {
    const cfg = parseConfigYaml(FILE.join('\n'));
    expect(cfg.activeContext).toEqual({ type: 'personality', name: 'engineer' });
  });
});
