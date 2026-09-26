// The inline consolidation fallback (`build-agent-loop`, the `consolidate` port
// handed to `MemoryCaptureRunner`) must honour `memoryApproval.mode: all`,
// which `MemoryApprovalMode` documents as gating `consolidation`. Before this
// test it wrote through `withHistory(captureBase, …)` with no gate in every
// mode. Driven through the REAL composition root: the runner `createAgentLoop`
// built is reached by spying `registerHook`, and its `consolidate` port is
// called directly with the LLM pass stubbed (`consolidateMemory`), since the
// size/count thresholds that trigger it need a live model.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ConsolidateFn, MemoryCaptureRunner } from '@ethosagent/memory-capture';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import type { MemoryContext } from '@ethosagent/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentLoop, type WiringConfig } from '../index';

vi.mock('@ethosagent/nightly-loop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ethosagent/nightly-loop')>()),
  consolidateMemory: vi.fn(async () => ({ memory: 'Consolidated context.', user: '' })),
}));

const SCOPE = 'personality:muse';

let home: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-memory-consolidation-gate-'));
  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
  process.env.HOME = home;
});

afterAll(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ctx: MemoryContext = {
  scopeId: SCOPE,
  sessionId: 's1',
  sessionKey: 'cli:s1',
  platform: 'cli',
  workingDir: '',
};

async function assemble(mode: 'off' | 'automated' | 'all') {
  const dataDir = mkdtempSync(join(home, 'data-'));
  mkdirSync(dataDir, { recursive: true });
  process.env.ETHOS_STATE_DIR = dataDir;
  const runners: MemoryCaptureRunner[] = [];
  const original = MemoryCaptureRunner.prototype.registerHook;
  vi.spyOn(MemoryCaptureRunner.prototype, 'registerHook').mockImplementation(function (
    this: MemoryCaptureRunner,
    hooks,
  ) {
    runners.push(this);
    return original.call(this, hooks);
  });
  const config: WiringConfig = {
    provider: 'ollama',
    model: 'offline-test',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'sk-dummy',
    memory: 'markdown',
    memoryCapture: { enabled: true },
    memoryApproval: { mode },
  };
  const runtime = await createAgentLoop(config, {
    dataDir,
    workingDir: home,
    disableDocker: true,
    profile: 'cli',
  });
  expect(runners).toHaveLength(1);
  const consolidate = (runners[0] as unknown as { opts: { consolidate?: ConsolidateFn } }).opts
    .consolidate;
  if (!consolidate) throw new Error('inline consolidation is wired when nightly is off');
  const editing = runtime.memoryBundle.editing;
  if (!editing.supported) throw new Error('markdown supports editing');
  const memory = async () => (await editing.editor.read('MEMORY.md', ctx))?.content ?? '';
  return { runtime, consolidate, memory, history: editing.history };
}

describe('inline consolidation under memoryApproval', () => {
  it('mode all parks the consolidation write as a pending consolidation entry', async () => {
    const { runtime, consolidate, memory, history } = await assemble('all');
    try {
      const sync = vi.spyOn(MarkdownFileMemoryProvider.prototype, 'sync');
      await consolidate({ scopeId: SCOPE, ctx });
      expect(sync).not.toHaveBeenCalled();
      expect(await memory()).toBe('');
      const pending = await runtime.memoryBundle.pending.list(SCOPE);
      expect(pending.map((p) => [p.source, p.update])).toEqual([
        [
          'consolidation',
          { action: 'replace', key: 'MEMORY.md', content: 'Consolidated context.' },
        ],
      ]);

      // Approve replays it under its original source.
      sync.mockRestore();
      const [entry] = pending;
      if (!entry) throw new Error('one pending entry');
      await runtime.memoryBundle.pending.approve(SCOPE, entry.id, 'web');
      expect((await memory()).trim()).toBe('Consolidated context.');
      const { entries } = await history.read(SCOPE);
      expect(entries.map((e) => [e.source, e.approvedBy])).toEqual([['consolidation', 'web']]);
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  it.each(['off', 'automated'] as const)(
    'mode %s writes the consolidation through, recorded as consolidation',
    async (mode) => {
      const { runtime, consolidate, memory, history } = await assemble(mode);
      try {
        await consolidate({ scopeId: SCOPE, ctx });
        expect((await memory()).trim()).toBe('Consolidated context.');
        expect(await runtime.memoryBundle.pending.list(SCOPE)).toHaveLength(0);
        const { entries } = await history.read(SCOPE);
        expect(entries.map((e) => e.source)).toEqual(['consolidation']);
      } finally {
        await runtime.dispose();
      }
    },
    120_000,
  );
});
