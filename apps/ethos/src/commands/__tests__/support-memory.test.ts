// F04 follow-up — `ethos support bundle --include-memory` captures the memory
// the AGENT reads: the configured backend (the vault under `memory: vault`), in
// the active personality's scope. It used to read `<dataDir>/MEMORY.md`, the
// pre-scoping root — empty under a vault, and a file nothing reads under
// markdown. A backend with no file memory says so instead of shipping nothing.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTarGz, SQLiteObservabilityStore } from '@ethosagent/observability-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBundle } from '../support';

const PERSONALITY = 'demo';

let root: string;
let dataDir: string;
let vaultRoot: string;
let prevStateDir: string | undefined;
let out: string[];

/** `runBundle` needs an observability.db to open; an empty one is enough. */
function seedObservability(dir: string): void {
  new SQLiteObservabilityStore(join(dir, 'observability.db')).close();
}

async function writeConfig(extra: string): Promise<void> {
  await writeFile(
    join(dataDir, 'config.yaml'),
    `provider: anthropic\nmodel: claude-test\npersonality: ${PERSONALITY}\n${extra}`,
  );
}

/** The bundle's `memory.md`, or null when it carries none. */
async function bundledMemory(): Promise<string | null> {
  const archive = out
    .flatMap((line) => line.split('\n'))
    .map((line) => line.match(/^Output: (\S+\.tar\.gz)/)?.[1])
    .find((name): name is string => name !== undefined);
  if (!archive) throw new Error(`no archive in output:\n${out.join('\n')}`);
  const path = join(process.cwd(), archive);
  const files = readTarGz(await readFile(path));
  await rm(path, { force: true });
  return files.get('memory.md')?.toString('utf8') ?? null;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ethos-support-memory-'));
  dataDir = join(root, 'ethos');
  vaultRoot = join(root, 'vault');
  await mkdir(join(dataDir, 'personalities', PERSONALITY), { recursive: true });
  await mkdir(join(vaultRoot, 'Ethos', 'personalities', PERSONALITY), { recursive: true });
  prevStateDir = process.env.ETHOS_STATE_DIR;
  process.env.ETHOS_STATE_DIR = dataDir;
  seedObservability(dataDir);
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.join(' '));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (prevStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = prevStateDir;
  await rm(root, { recursive: true, force: true });
});

describe('support bundle --include-memory follows the configured backend', () => {
  it('captures the vault scope under memory: vault, not <dataDir>/MEMORY.md', async () => {
    await writeConfig(`memory: vault\nmemoryVault.path: ${vaultRoot}\n`);
    const scopeDir = join(vaultRoot, 'Ethos', 'personalities', PERSONALITY);
    await writeFile(join(scopeDir, 'MEMORY.md'), 'vault project context\n');
    await writeFile(join(scopeDir, 'USER.md'), 'vault user profile\n');
    // The pre-scoping root file the old code read — must NOT be what lands.
    await writeFile(join(dataDir, 'MEMORY.md'), 'stale root file\n');

    await runBundle(['--include-memory']);

    const memory = await bundledMemory();
    expect(memory).toContain('vault project context');
    expect(memory).toContain('vault user profile');
    expect(memory).not.toContain('stale root file');
  });

  it('captures the personality scope under markdown memory', async () => {
    await writeConfig('');
    await writeFile(
      join(dataDir, 'personalities', PERSONALITY, 'MEMORY.md'),
      'scoped project context\n',
    );
    await writeFile(join(dataDir, 'MEMORY.md'), 'stale root file\n');

    await runBundle(['--include-memory']);

    const memory = await bundledMemory();
    expect(memory).toContain('scoped project context');
    expect(memory).not.toContain('stale root file');
  });

  it('says why it captured nothing under a backend with no file memory', async () => {
    await writeConfig('memory: vector\n');
    await runBundle(['--include-memory']);
    expect(await bundledMemory()).toContain('"vector" memory backend has no file editor');
  });

  it('captures nothing without the flag', async () => {
    await writeConfig('');
    await writeFile(
      join(dataDir, 'personalities', PERSONALITY, 'MEMORY.md'),
      'scoped project context\n',
    );
    await runBundle([]);
    expect(await bundledMemory()).toBeNull();
  });
});
