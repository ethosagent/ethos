import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import { FsStorage } from '@ethosagent/storage-fs';
import { createMemoryProviderFromConfig } from '@ethosagent/wiring';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileMemorySnapshot } from '../../lib/file-memory';
import { createSlackMemoryReader } from '../gateway';
import { runMemoryFileCommand } from '../memory-file';
import { runMemoryHistory } from '../memory-history';
import { runMemoryRestore } from '../memory-restore';
import { runMemoryRetract } from '../memory-retract';
import { runMemorySupersede } from '../memory-supersede';

// F04 follow-up (plan architecture-suggestions-2026-09-10) — the CLI memory
// verbs must act on the backend the agent reads. Under `memory: vault` the
// agent reads `<vault>/Ethos/personalities/<id>/`; before this, `ethos memory
// restore|retract|supersede|history` all opened markdown at ~/.ethos and never
// touched the vault. The approval tombstones stay at ~/.ethos (gate state).
// Chat's and the TUI's `/memory`, `ethos memory add|show|clear` and the Slack
// `/ethos memory` reader had the same gap. Under `memory: vector` every file
// surface refuses (NOT_CONFIGURED) instead of editing markdown nothing reads.

const PERSONALITY = 'muse';

let root: string;
let dataDir: string;
let vaultRoot: string;
let vaultScopeDir: string;
let prevStateDir: string | undefined;

async function writeConfig(extra: string): Promise<void> {
  await writeFile(
    join(dataDir, 'config.yaml'),
    [
      'schemaVersion: 1',
      'provider: anthropic',
      'model: claude-test',
      'apiKey: sk-test',
      `personality: ${PERSONALITY}`,
      extra,
      '',
    ].join('\n'),
  );
}

const read = (path: string): Promise<string | null> => readFile(path, 'utf-8').catch(() => null);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ethos-memory-cli-backend-'));
  dataDir = join(root, 'ethos');
  vaultRoot = join(root, 'vault');
  vaultScopeDir = join(vaultRoot, 'Ethos', 'personalities', PERSONALITY);
  prevStateDir = process.env.ETHOS_STATE_DIR;
  process.env.ETHOS_STATE_DIR = dataDir;
});

afterAll(async () => {
  if (prevStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = prevStateDir;
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(vaultRoot, { recursive: true, force: true });
  await mkdir(join(dataDir, 'personalities', PERSONALITY), { recursive: true });
  await mkdir(vaultScopeDir, { recursive: true });
  // A failing command calls process.exit — turn that into a thrown error so a
  // pre-fix run fails the test instead of killing the worker.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CLI memory verbs under memory: vault', () => {
  beforeEach(async () => {
    await writeConfig(`memory: vault\nmemoryVault.path: ${vaultRoot}`);
  });

  it('restore moves an archived section back into the vault', async () => {
    const iso = new Date().toISOString();
    await writeFile(
      join(vaultScopeDir, 'memory-archive.md'),
      `<!-- archived ${iso} slug=old-project from=MEMORY.md -->\n### old-project\n\nShipped in 2024.`,
    );

    await runMemoryRestore(['old-project']);

    expect(await read(join(vaultScopeDir, 'MEMORY.md'))).toContain('### old-project');
    expect(await read(join(vaultScopeDir, 'memory-archive.md'))).not.toContain('slug=old-project');
    expect(await read(join(dataDir, 'personalities', PERSONALITY, 'MEMORY.md'))).toBeNull();
  });

  it('retract archives the vault section; the tombstone stays at ~/.ethos', async () => {
    await writeFile(
      join(vaultScopeDir, 'MEMORY.md'),
      '### keep\n\n- stays put\n\n### wrong\n\n- lives in Paris\n',
    );

    await runMemoryRetract(['wrong', '--reason', 'moved']);

    const memory = await read(join(vaultScopeDir, 'MEMORY.md'));
    expect(memory).toContain('### keep');
    expect(memory).not.toContain('### wrong');
    expect(await read(join(vaultScopeDir, 'memory-archive.md'))).toContain('Retracted: moved');
    // The lifecycle sidecar lives beside the content it describes.
    expect(await read(join(vaultScopeDir, 'memory-meta.json'))).toContain('retracted');
    // Gate state (tombstones) stays at ~/.ethos for every backend.
    expect(
      await read(join(dataDir, 'personalities', PERSONALITY, 'memory-tombstones.jsonl')),
    ).not.toBeNull();
    expect(await read(join(vaultScopeDir, 'memory-tombstones.jsonl'))).toBeNull();
  });

  it('supersede archives the vault section under a Superseded note', async () => {
    await writeFile(
      join(vaultScopeDir, 'MEMORY.md'),
      '### old-plan\n\n- ship in May\n\n### new-plan\n\n- ship in June\n',
    );

    await runMemorySupersede(['old-plan', '--by', 'new-plan']);

    const memory = await read(join(vaultScopeDir, 'MEMORY.md'));
    expect(memory).not.toContain('### old-plan');
    expect(memory).toContain('### new-plan');
    expect(await read(join(vaultScopeDir, 'memory-archive.md'))).toContain(
      'Superseded by [[#new-plan]]',
    );
    expect(await read(join(vaultScopeDir, 'memory-meta.json'))).toContain('superseded');
  });

  it('history reads the vault history (<vault>/Ethos/.ethos-meta)', async () => {
    // A write the agent side records (nightly consolidation into the vault).
    await createMemoryProviderFromConfig({
      config: { memory: 'vault', memoryVault: { path: vaultRoot } },
      dataDir,
      storage: new FsStorage(),
      source: 'consolidation',
    }).provider.sync([{ action: 'add', key: 'MEMORY.md', content: 'consolidated fact' }], {
      scopeId: `personality:${PERSONALITY}`,
      sessionId: '',
      sessionKey: 'nightly',
      platform: 'cli',
      workingDir: '',
    });

    const logs: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      logs.push(String(chunk));
      return true;
    }) as never);
    await runMemoryHistory(['--json']);
    const out = JSON.parse(logs.join('')) as { entries: Array<{ source: string }> };
    expect(out.entries.map((e) => e.source)).toEqual(['consolidation']);
  });
});

describe('file-memory surfaces under memory: vault', () => {
  const config = (): EthosConfig =>
    ({
      provider: 'anthropic',
      model: 'claude-test',
      personality: PERSONALITY,
      memory: 'vault',
      memoryVault: { path: vaultRoot },
    }) as EthosConfig;

  it('`ethos memory add` writes the vault and `show` reads it back', async () => {
    await runMemoryFileCommand(
      'add',
      ['memory', 'add', 'Use the staging account'],
      config(),
      false,
    );
    expect(await read(join(vaultScopeDir, 'MEMORY.md'))).toContain('Use the staging account');
    expect(await read(join(dataDir, 'personalities', PERSONALITY, 'MEMORY.md'))).toBeNull();

    const logs: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      logs.push(String(chunk));
      return true;
    }) as never);
    await runMemoryFileCommand('show', ['memory', 'show'], config(), true);
    const out = JSON.parse(logs.join('')) as { entries: Array<{ content: string }> };
    expect(out.entries.map((e) => e.content).join('\n')).toContain('Use the staging account');
  });

  it('chat/TUI `/memory` shows the vault content', async () => {
    await writeFile(join(vaultScopeDir, 'MEMORY.md'), 'deploys on tuesdays\n');
    expect(
      await readFileMemorySnapshot(config(), { personalityId: PERSONALITY, sessionKey: 'cli:x' }),
    ).toContain('deploys on tuesdays');
  });

  it('the Slack `/ethos memory` reader reads and appends to the vault', async () => {
    const reader = createSlackMemoryReader(PERSONALITY, config());
    if (!reader) throw new Error('vault supports file memory');
    await reader.append('added from slack');
    expect(await read(join(vaultScopeDir, 'MEMORY.md'))).toContain('added from slack');
    expect(await reader.read()).toContain('added from slack');
  });
});

describe('file-memory surfaces under memory: vector refuse', () => {
  beforeEach(async () => {
    await writeConfig('memory: vector');
  });

  const vectorConfig = (): EthosConfig =>
    ({
      provider: 'anthropic',
      model: 'claude-test',
      personality: PERSONALITY,
      memory: 'vector',
    }) as EthosConfig;
  const refusal = {
    code: 'NOT_CONFIGURED',
    message: expect.stringContaining('"vector" memory backend has no file editor'),
  };

  it('restore, retract, supersede, history and add all refuse; nothing is written', async () => {
    await expect(runMemoryRestore(['anything'])).rejects.toMatchObject(refusal);
    await expect(runMemoryRetract(['anything'])).rejects.toMatchObject(refusal);
    await expect(runMemorySupersede(['anything', '--by', 'other'])).rejects.toMatchObject(refusal);
    await expect(runMemoryHistory([])).rejects.toMatchObject(refusal);
    await expect(
      runMemoryFileCommand('add', ['memory', 'add', 'x'], vectorConfig(), false),
    ).rejects.toMatchObject(refusal);
    await expect(
      readFileMemorySnapshot(vectorConfig(), { personalityId: PERSONALITY, sessionKey: 'cli:x' }),
    ).rejects.toMatchObject(refusal);
    expect(await read(join(dataDir, 'personalities', PERSONALITY, 'MEMORY.md'))).toBeNull();
  });

  it('the Slack reader is withheld, so the command answers "Memory is unavailable"', () => {
    expect(createSlackMemoryReader(PERSONALITY, vectorConfig())).toBeUndefined();
  });
});
