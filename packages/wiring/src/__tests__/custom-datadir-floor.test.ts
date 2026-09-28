// Verification round F2 (plan personality-memory-boundary) — a host may hand
// `createAgentLoop` a data directory that is neither `~/.ethos` nor
// `ETHOS_STATE_DIR` (the desktop app's custom data folder). The floors used to
// be computed from the environment alone, so every state-dir deny and the
// definition write floor missed that directory. This drives the REAL wiring:
// a `write_file` / `read_file` through the registry `createAgentLoop` built,
// with the working directory (and so the default reach) ABOVE the data dir. Not
// AT it: a cwd at or inside the state dir is dropped from the default reach
// (UBP-047, `deriveFsReachPaths`), and wiring passes the data dir as the
// reach's `ethosHome`. The floors hold on their own, and — since post-merge
// round I1 — so does the ancestor-grant exclusion (layer 2b) and the tainted
// state-dir write refusal (1d): wiring hands the data dir to every
// `ScopedFsImpl` (`CapabilityBackends.stateDirs`,
// packages/wiring/src/build-infrastructure.ts), so the root's grant no longer
// reaches into it.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRunTaint } from '../../../core/src/scoped/run-taint';
import { createAgentLoop, type WiringConfig } from '../index';

describe('a custom dataDir is floored on the scopedFs boundary (verification round F2)', () => {
  let root: string;
  let dataDir: string;
  let runtime: Awaited<ReturnType<typeof createAgentLoop>>;
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ethos-custom-datadir-'));
    dataDir = join(root, 'desktop-data');
    const own = join(dataDir, 'personalities', 'p');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'config.yaml'), 'name: p\n');
    writeFileSync(join(own, 'SOUL.md'), '# p\n');
    writeFileSync(join(own, 'toolset.yaml'), '- read_file\n- write_file\n');
    writeFileSync(join(dataDir, 'constitution.yaml'), 'tools: {}\n');
    const other = join(dataDir, 'personalities', 'other');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'MEMORY.md'), 'OTHER-PRIVATE');
    for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
    // HOME elsewhere and no ETHOS_STATE_DIR: only wiring knows the data dir.
    process.env.HOME = join(root, 'home');
    delete process.env.ETHOS_STATE_DIR;
    const config: WiringConfig = {
      provider: 'ollama',
      model: 'offline-test',
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'sk-dummy',
      personality: 'p',
      memory: 'markdown',
    };
    runtime = await createAgentLoop(config, {
      dataDir,
      workingDir: root,
      disableDocker: true,
      profile: 'cli',
    });
  }, 120_000);

  afterAll(async () => {
    await runtime?.dispose();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const ctx = (): ToolContext =>
    ({
      sessionId: 's',
      sessionKey: 'cli:custom-datadir',
      platform: 'cli',
      personalityId: 'p',
      workingDir: root,
      currentTurn: 1,
      messageCount: 1,
      abortSignal: new AbortController().signal,
      emit: () => {},
      resultBudgetChars: 80_000,
    }) as ToolContext;

  async function call(name: string, args: Record<string, unknown>) {
    const [result] = await runtime.toolRegistry.executeParallel(
      [{ toolCallId: 'c1', name, args }],
      ctx(),
    );
    return result?.result;
  }

  it("refuses a write to another personality's toolset.yaml under the data dir", async () => {
    const target = join(dataDir, 'personalities', 'other', 'toolset.yaml');
    const result = await call('write_file', { path: target, content: '- terminal\n' });
    expect(result?.ok).toBe(false);
    expect(() => readFileSync(target, 'utf-8')).toThrow();
  });

  it('refuses to read or rewrite the constitution under the data dir', async () => {
    const path = join(dataDir, 'constitution.yaml');
    expect((await call('read_file', { path }))?.ok).toBe(false);
    expect((await call('write_file', { path, content: 'tools: { allow: ["*"] }\n' }))?.ok).toBe(
      false,
    );
    expect(readFileSync(path, 'utf-8')).toBe('tools: {}\n');
  });

  // Post-merge round I1 — the root's grant is an ancestor of the data dir.
  it("an ancestor grant does not reach another personality's memory in the data dir", async () => {
    const path = join(dataDir, 'personalities', 'other', 'MEMORY.md');
    expect((await call('read_file', { path }))?.ok).toBe(false);
    expect((await call('write_file', { path, content: 'x' }))?.ok).toBe(false);
    expect((await call('write_file', { path: join(dataDir, 'notes.md'), content: 'x' }))?.ok).toBe(
      false,
    );
    expect(readFileSync(path, 'utf-8')).toBe('OTHER-PRIVATE');
  });

  it('a tainted run cannot write into the data dir, even its own directory', async () => {
    const link = { state: { untrustedSeen: true }, open: true, mark: () => {} };
    const own = join(dataDir, 'personalities', 'p', 'notes.md');
    const result = await withRunTaint(link, () => call('write_file', { path: own, content: 'x' }));
    expect(result?.ok).toBe(false);
    expect(() => readFileSync(own, 'utf-8')).toThrow();
  });

  it('still writes an ordinary file in the reach', async () => {
    expect((await call('write_file', { path: join(root, 'notes.md'), content: 'ok' }))?.ok).toBe(
      true,
    );
    const own = join(dataDir, 'personalities', 'p', 'notes.md');
    expect((await call('write_file', { path: own, content: 'ok' }))?.ok).toBe(true);
  });
});
