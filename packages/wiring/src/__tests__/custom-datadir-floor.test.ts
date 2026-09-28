// Verification round F2 (plan personality-memory-boundary) — a host may hand
// `createAgentLoop` a data directory that is neither `~/.ethos` nor
// `ETHOS_STATE_DIR` (the desktop app's custom data folder). The floors used to
// be computed from the environment alone, so every state-dir deny and the
// definition write floor missed that directory. This drives the REAL wiring:
// a `write_file` / `read_file` through the registry `createAgentLoop` built,
// with the working directory (and so the default reach) on the data dir.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
      workingDir: dataDir,
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
      workingDir: dataDir,
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

  it('still writes an ordinary file in the reach', async () => {
    const path = join(dataDir, 'notes.md');
    expect((await call('write_file', { path, content: 'ok' }))?.ok).toBe(true);
  });
});
