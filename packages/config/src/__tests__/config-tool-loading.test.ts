// reach-and-containment Part 1 (C5) — `tool_loading: auto|on|off`, the
// operator setting for on-demand tool loading. An unknown value is a parse
// error naming the key (`configParseNotices` → the strict boot paths refuse);
// it is never silently read as the `auto` default.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  configParseNotices,
  ethosDir,
  loadConfigStrict,
  readRawConfig,
  writeConfig,
} from '../index';

const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

async function storageWith(...extra: string[]) {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), [...base, ...extra].join('\n'));
  return storage;
}

describe('tool_loading config', () => {
  it.each(['auto', 'on', 'off'] as const)('parses %s', async (mode) => {
    const cfg = await readRawConfig(await storageWith(`tool_loading: ${mode}`));
    expect(cfg?.toolLoading).toBe(mode);
    expect(cfg ? configParseNotices(cfg).errors : ['missing']).toEqual([]);
  });

  it('is absent when unset (wiring then defaults to auto)', async () => {
    const cfg = await readRawConfig(await storageWith());
    expect(cfg?.toolLoading).toBeUndefined();
    expect(cfg ? configParseNotices(cfg).errors : ['missing']).toEqual([]);
  });

  it('refuses an unknown value at boot, naming the key', async () => {
    const storage = await storageWith('tool_loading: sometimes');
    const cfg = await readRawConfig(storage);
    expect(cfg?.toolLoading).toBeUndefined();
    const errors = cfg ? configParseNotices(cfg).errors : [];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('tool_loading');
    expect(errors[0]).toContain('sometimes');

    // The strict loader the gateway / boot paths use surfaces it as fatal.
    const loaded = await loadConfigStrict(storage);
    expect(loaded?.parseErrors.some((e) => e.startsWith('tool_loading:'))).toBe(true);
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      { provider: 'ollama', model: 'llama3.2', apiKey: 'sk', personality: 'p', toolLoading: 'on' },
      new InMemorySecretsResolver(),
    );
    const cfg = await readRawConfig(storage);
    expect(cfg?.toolLoading).toBe('on');
  });
});
