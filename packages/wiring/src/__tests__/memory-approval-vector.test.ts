// `memoryApproval` under `memory: vector`. The `vector` registry factory
// (`build-infrastructure`) used to return a bare `VectorMemoryProvider`, so
// the approve-before-store gate never ran: under `mode: all` a `memory_write`
// landed in memory.db, and under `automated` a dream turn's write did too.
// Driven through the REAL composition root (`createAgentLoop`), then approved
// through the loop's own `memoryBundle.pending` — the queue the web Pending tab
// and `ethos memory pending` use — which must replay into memory.db.
//
// Embeddings are stubbed on the prototype so no model is downloaded.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VectorMemoryProvider } from '@ethosagent/memory-vector';
import { FsStorage } from '@ethosagent/storage-fs';
import type { MemoryContext, ToolContext } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentLoop, type WiringConfig } from '../index';

const PERSONALITY = 'muse';
const SCOPE = `personality:${PERSONALITY}`;

let home: string;
let dataDir: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-memory-approval-vector-'));
  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
  process.env.HOME = home;
  vi.spyOn(
    VectorMemoryProvider.prototype as unknown as { embed: (t: string) => Promise<Float32Array> },
    'embed',
  ).mockResolvedValue(new Float32Array([1, 0, 0]));
});

afterAll(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function freshDataDir(name: string): string {
  dataDir = join(home, name, '.ethos');
  mkdirSync(dataDir, { recursive: true });
  process.env.ETHOS_STATE_DIR = dataDir;
  return dataDir;
}

function vectorConfig(mode: 'off' | 'automated' | 'all'): WiringConfig {
  return {
    provider: 'ollama',
    model: 'offline-test',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'sk-dummy',
    memory: 'vector',
    memoryApproval: { mode },
  };
}

function toolCtx(sessionKey = 'cli:test'): ToolContext {
  return {
    sessionId: 's',
    sessionKey,
    platform: 'cli',
    workingDir: home,
    personalityId: PERSONALITY,
    memoryScopeId: SCOPE,
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 20_000,
  };
}

const readCtx: MemoryContext = {
  scopeId: SCOPE,
  sessionId: '',
  sessionKey: '',
  platform: 'cli',
  workingDir: '',
};

/** What memory.db holds for MEMORY.md, read through a separate connection. */
async function storedMemory(dir: string): Promise<string | undefined> {
  const reader = new VectorMemoryProvider({ dir, storage: new FsStorage() });
  try {
    return (await reader.read('MEMORY.md', readCtx))?.content;
  } finally {
    reader.close();
  }
}

async function write(
  runtime: Awaited<ReturnType<typeof createAgentLoop>>,
  content: string,
  sessionKey?: string,
): Promise<void> {
  const memoryWrite = runtime.toolRegistry.get('memory_write');
  if (!memoryWrite) throw new Error('memory_write is registered on every loop');
  const result = await memoryWrite.execute(
    { store: 'memory', action: 'add', content },
    toolCtx(sessionKey),
  );
  expect(result.ok).toBe(true);
}

describe('memoryApproval under memory: vector', () => {
  it('mode all parks a memory_write, and approve replays it into memory.db', async () => {
    const dir = freshDataDir('all');
    const runtime = await createAgentLoop(vectorConfig('all'), {
      dataDir: dir,
      workingDir: home,
      profile: 'web',
      disableDocker: true,
    });
    try {
      await write(runtime, 'Deploys on Tuesdays');
      expect(await storedMemory(dir)).toBeUndefined();
      const pending = await runtime.memoryBundle.pending.list(SCOPE);
      expect(pending.map((p) => [p.source, p.update.key])).toEqual([['tool', 'MEMORY.md']]);

      const [entry] = pending;
      if (!entry) throw new Error('one pending entry');
      await runtime.memoryBundle.pending.approve(SCOPE, entry.id, 'web');
      expect(await storedMemory(dir)).toBe('Deploys on Tuesdays');
      expect(await runtime.memoryBundle.pending.list(SCOPE)).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  it('mode automated parks a dream turn write but lets an explicit tool write through', async () => {
    const dir = freshDataDir('automated');
    const runtime = await createAgentLoop(vectorConfig('automated'), {
      dataDir: dir,
      workingDir: home,
      profile: 'web',
      disableDocker: true,
    });
    try {
      await write(runtime, 'Dreamt fact', 'dream:muse:1');
      await write(runtime, 'Explicit fact');
      expect(await storedMemory(dir)).toBe('Explicit fact');
      const pending = await runtime.memoryBundle.pending.list(SCOPE);
      expect(pending.map((p) => [p.source, p.update])).toEqual([
        ['dream', { action: 'add', key: 'MEMORY.md', content: 'Dreamt fact' }],
      ]);
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  it('mode off writes straight through, unchanged', async () => {
    const dir = freshDataDir('off');
    const runtime = await createAgentLoop(vectorConfig('off'), {
      dataDir: dir,
      workingDir: home,
      profile: 'web',
      disableDocker: true,
    });
    try {
      await write(runtime, 'Dreamt fact', 'dream:muse:1');
      expect(await storedMemory(dir)).toBe('Dreamt fact');
      expect(await runtime.memoryBundle.pending.list(SCOPE)).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  }, 60_000);
});
