// UBP-009 — `ethos plugin trust [dir]` is how an operator grants a workspace
// plugin permission to load; `ethos plugin untrust [dir]` withdraws it. The
// grant lands where `PluginLoader.loadAll` reads it:
// `~/.ethos/plugins/workspace-trust.json`, keyed on directory + content hash.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceTrustState } from '@ethosagent/plugin-loader';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPlugin } from '../commands/plugin';

let root: string;
let savedHome: string | undefined;

beforeEach(async () => {
  root = join(tmpdir(), `ethos-plugin-trust-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(join(root, 'home'), { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = join(root, 'home');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

describe('ethos plugin trust / untrust', () => {
  it('grants and withdraws trust for each workspace plugin under the directory', async () => {
    const repo = join(root, 'repo');
    const pluginDir = join(repo, '.ethos', 'plugins', 'helper');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'index.js'), 'export async function activate() {}');
    const pluginsDir = join(root, 'home', '.ethos', 'plugins');
    const storage = new FsStorage();

    expect(await workspaceTrustState(storage, pluginsDir, pluginDir)).toBe('untrusted');
    await runPlugin(['trust', repo]);
    expect(await workspaceTrustState(storage, pluginsDir, pluginDir)).toBe('trusted');

    await runPlugin(['untrust', repo]);
    expect(await workspaceTrustState(storage, pluginsDir, pluginDir)).toBe('untrusted');
  });
});
