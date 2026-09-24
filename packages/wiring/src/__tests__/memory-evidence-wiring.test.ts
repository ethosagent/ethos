// Plan openclaw-9.5-adoption item 3 (D22) — `memoryCapture.evidenceSessions`
// through the REAL composition root. `createAgentLoop` is the one place a
// `MemoryCaptureRunner` is built (`build-agent-loop.ts`), and every host —
// `ethos chat`, `gateway start`, `boot`, `serve`, cron, the team loops — reaches
// it through `apps/ethos/src/wiring.ts`'s `createAgentLoop` (pinned separately
// by `apps/ethos/src/__tests__/memory-evidence-host-wiring.test.ts`). So this
// test pins the routing every host gets:
//   - approval off + N>0  → capture proposes to a capture-only queue that
//     promotes at N distinct sessions as `approvedBy: 'evidence'`;
//   - approval off + N=0  → no queue at all, capture writes directly (today);
//   - approval automated + N>0 → queued and ordered, never auto-approved.
//
// Offline: HOME and ETHOS_STATE_DIR point at a temp dir, the provider baseUrl is
// a closed port, and every runtime is disposed. The runner is reached by spying
// `registerHook` (the call `build-agent-loop` makes on the runner it built), and
// its `propose` port is driven directly, since extraction needs a live model.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryCaptureRunner, type ProposeFn } from '@ethosagent/memory-capture';
import type { MemoryContext } from '@ethosagent/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentLoop, type WiringConfig } from '../index';

const SCOPE = 'personality:muse';
const HASH = 'evidence-wiring-hash';

let home: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-memory-evidence-wiring-'));
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

function config(extra: Partial<WiringConfig>): WiringConfig {
  return {
    provider: 'ollama',
    model: 'offline-test',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'sk-dummy',
    memory: 'markdown',
    ...extra,
  };
}

/** Assemble a runtime in a fresh data dir; return it with the capture runner's `propose` port. */
async function assemble(extra: Partial<WiringConfig>) {
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
  const runtime = await createAgentLoop(config(extra), {
    dataDir,
    workingDir: home,
    disableDocker: true,
    profile: 'cli',
  });
  expect(runners).toHaveLength(1);
  // The runner's options are private; the port is what wiring chose to hand it.
  const propose = (runners[0] as unknown as { opts: { propose?: ProposeFn } }).opts.propose;
  return { runtime, propose };
}

function proposal(sessionId: string) {
  return {
    scopeId: SCOPE,
    update: { action: 'add' as const, key: 'USER.md', content: '\n- Prefers green tea.' },
    source: 'capture' as const,
    factHash: HASH,
    sessionId,
    sessionKey: `cli:${sessionId}`,
  };
}

const readCtx: MemoryContext = {
  scopeId: SCOPE,
  sessionId: '',
  sessionKey: '',
  platform: 'cli',
  workingDir: '',
};

describe('createAgentLoop — memoryCapture.evidenceSessions routing', () => {
  it('approval off + N=3: capture goes through the queue and promotes as evidence at 3 sessions', async () => {
    const { runtime, propose } = await assemble({
      memoryCapture: { enabled: true, evidenceSessions: 3 },
    });
    try {
      expect(propose).toBeDefined();
      const editing = runtime.memoryBundle.editing;
      if (!editing.supported) throw new Error('markdown must support editing');
      const user = async () => (await editing.editor.read('USER.md', readCtx))?.content ?? '';

      await propose?.(proposal('s1'));
      await propose?.(proposal('s2'));
      expect(await user()).not.toContain('green tea');
      const queued = await runtime.memoryBundle.pending.list(SCOPE);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.evidenceSessions).toEqual(['s1', 's2']);

      await propose?.(proposal('s3'));
      expect(await user()).toContain('green tea');
      expect(await runtime.memoryBundle.pending.list(SCOPE)).toHaveLength(0);
      const { entries } = await editing.history.read(SCOPE);
      expect(entries.map((e) => [e.source, e.approvedBy, e.captureHashes])).toEqual([
        ['capture', 'evidence', [HASH]],
      ]);
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  it.each([
    ['absent', { enabled: true }],
    ['0', { enabled: true, evidenceSessions: 0 }],
  ])(
    'approval off + evidenceSessions %s: no queue, capture writes directly as today',
    async (_label, memoryCapture) => {
      const { runtime, propose } = await assemble({ memoryCapture });
      try {
        expect(propose).toBeUndefined();
      } finally {
        await runtime.dispose();
      }
    },
    120_000,
  );

  it('approval automated + N=3: queued with evidence and ordered, never auto-approved', async () => {
    const { runtime, propose } = await assemble({
      memoryCapture: { enabled: true, evidenceSessions: 3 },
      memoryApproval: { mode: 'automated' },
    });
    try {
      await propose?.({ ...proposal('s1'), factHash: 'older-once' });
      for (const s of ['s1', 's2', 's3', 's4']) await propose?.(proposal(s));

      // The host-side queue (CLI `ethos memory pending`, web) reads the same
      // file and orders by evidence, most-evidenced first.
      const listed = await runtime.memoryBundle.pending.list(SCOPE);
      expect(listed.map((e) => [e.factHash, e.evidenceSessions?.length])).toEqual([
        [HASH, 4],
        ['older-once', 1],
      ]);
      const editing = runtime.memoryBundle.editing;
      if (!editing.supported) throw new Error('markdown must support editing');
      expect((await editing.editor.read('USER.md', readCtx))?.content ?? '').not.toContain(
        'green tea',
      );
    } finally {
      await runtime.dispose();
    }
  }, 120_000);
});
