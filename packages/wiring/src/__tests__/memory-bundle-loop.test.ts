// F04 (plan/phases/architecture-suggestions-2026-09-10.md) — the memory bundle
// a loop hands its hosts (`CreateAgentLoopResult.memoryBundle`) is built from
// the SAME config its memory registry resolves, so a web/desktop editor write
// is what the agent reads. Driven through the REAL composition root: a vault
// config goes into `createAgentLoop`, the bundle's editor writes, and the
// loop's own `memory_read` tool (registered over the loop's memory provider)
// reads it back. HOME and ETHOS_STATE_DIR point at a temp dir, the provider is
// offline, and the runtime is disposed afterwards.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryContext, ToolContext } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentLoop, type WiringConfig } from '../index';

const PERSONALITY = 'muse';

let home: string;
let dataDir: string;
let vaultRoot: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-memory-bundle-loop-'));
  dataDir = join(home, '.ethos');
  vaultRoot = join(home, 'vault');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(vaultRoot, { recursive: true });
  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
  process.env.HOME = home;
  process.env.ETHOS_STATE_DIR = dataDir;
});

afterAll(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

/** Offline provider: nothing here sends a completion. */
function vaultConfig(): WiringConfig {
  return {
    provider: 'ollama',
    model: 'offline-test',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'sk-dummy',
    memory: 'vault',
    memoryVault: { path: vaultRoot },
  };
}

function toolCtx(): ToolContext {
  return {
    sessionId: 's',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: home,
    personalityId: PERSONALITY,
    memoryScopeId: `personality:${PERSONALITY}`,
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 20_000,
  };
}

const editorCtx: MemoryContext = {
  scopeId: `personality:${PERSONALITY}`,
  sessionId: '',
  sessionKey: '',
  platform: 'web',
  workingDir: '',
};

describe('createAgentLoop — memoryBundle and the loop share one backend (F04)', () => {
  it('under memory: vault, an editor write is what the loop memory_read tool returns', async () => {
    const runtime = await createAgentLoop(vaultConfig(), {
      dataDir,
      workingDir: home,
      profile: 'web',
      disableDocker: true,
    });
    try {
      expect(runtime.memoryBundle.backend).toBe('vault');
      const editing = runtime.memoryBundle.editing;
      if (!editing.supported) throw new Error('vault supports file editing');

      await editing.editor.sync(
        [{ action: 'replace', key: 'MEMORY.md', content: 'Use the staging account' }],
        editorCtx,
      );

      const memoryRead = runtime.toolRegistry.get('memory_read');
      if (!memoryRead) throw new Error('memory_read is registered on every loop');
      const result = await memoryRead.execute({ store: 'memory' }, toolCtx());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toContain('Use the staging account');
      // …because both sides are the vault, not markdown under ~/.ethos.
      const memoryFile = join('personalities', PERSONALITY, 'MEMORY.md');
      expect(readFileSync(join(vaultRoot, 'Ethos', memoryFile), 'utf8')).toContain(
        'Use the staging account',
      );
      expect(existsSync(join(dataDir, memoryFile))).toBe(false);

      // And the other direction: the loop's memory_write lands where the editor reads.
      const memoryWrite = runtime.toolRegistry.get('memory_write');
      if (!memoryWrite) throw new Error('memory_write is registered on every loop');
      const written = await memoryWrite.execute(
        { store: 'memory', action: 'add', content: 'Deploys on Tuesdays' },
        toolCtx(),
      );
      expect(written.ok).toBe(true);
      expect((await editing.editor.read('MEMORY.md', editorCtx))?.content).toContain(
        'Deploys on Tuesdays',
      );
    } finally {
      await runtime.dispose();
    }
  });
});
