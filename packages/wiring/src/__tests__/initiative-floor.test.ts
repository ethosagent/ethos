// plan initiative-engine Task 3.4 — `initiatives/` under a personality is a
// definition entry: a turn's `write_file` is refused, while the compose-time
// Storage that `InitiativeConfigService` holds still writes it. Drives the
// real `write_file` tool over the scope `shippedScopedStorageFactory`
// (packages/wiring/src/build-agent-loop.ts) builds, on a temp state dir.

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScopedFsImpl } from '@ethosagent/core';
import * as storageFs from '@ethosagent/storage-fs';
import { writeFileTool } from '@ethosagent/tools-file';
import { BoundaryError, type ToolContext } from '@ethosagent/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { shippedScopedStorageFactory } from '../build-agent-loop';

describe('initiatives/ floor (R7)', () => {
  let root: string;
  let dataDir: string;
  let target: string;
  let grant: string;
  let other: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ethos-initiative-floor-'));
    dataDir = join(root, 'state');
    await mkdir(join(dataDir, 'personalities', 'p', 'initiatives'), { recursive: true });
    grant = `${join(dataDir, 'personalities', 'p')}/`;
    other = join(dataDir, 'personalities', 'p', 'other', 'x.yaml');
    target = join(dataDir, 'personalities', 'p', 'initiatives', 'x.yaml');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function turnCtx(): ToolContext {
    const base = new storageFs.FsStorage();
    const scoped = shippedScopedStorageFactory(storageFs, dataDir)(base, {
      read: [grant],
      write: [grant],
    });
    const fs = new ScopedFsImpl(
      scoped,
      new Set([grant]),
      new Set([grant]),
      [],
      [],
      undefined,
      undefined,
      [dataDir],
    );
    return {
      sessionId: 's',
      sessionKey: 'cli:floor',
      platform: 'cli',
      personalityId: 'p',
      workingDir: root,
      currentTurn: 1,
      messageCount: 1,
      abortSignal: new AbortController().signal,
      emit: () => {},
      resultBudgetChars: 80_000,
      scopedFs: fs,
    } as ToolContext;
  }

  it('R7 write_file to initiatives/x.yaml is refused', async () => {
    vi.stubEnv('ETHOS_STATE_DIR', dataDir);
    const result = await writeFileTool.execute({ path: target, content: 'x: 1\n' }, turnCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/personality definition/);
    await expect(readFile(target, 'utf-8')).rejects.toThrow();
  });

  it('the turn scope itself refuses it, with no tool pre-check', async () => {
    const base = new storageFs.FsStorage();
    const scoped = shippedScopedStorageFactory(storageFs, dataDir)(base, {
      read: [grant],
      write: [grant],
    });
    await expect(scoped.write(target, 'x: 1\n')).rejects.toBeInstanceOf(BoundaryError);
    await expect(readFile(target, 'utf-8')).rejects.toThrow();
  });

  it('control: a non-definition path in the same grant is writable through the tool', async () => {
    vi.stubEnv('ETHOS_STATE_DIR', dataDir);
    const result = await writeFileTool.execute({ path: other, content: 'x: 1\n' }, turnCtx());
    expect(result.ok).toBe(true);
    expect(await readFile(other, 'utf-8')).toBe('x: 1\n');
  });

  it('compose-time Storage still writes it', async () => {
    const base = new storageFs.FsStorage();
    await base.write(target, 'x: 1\n');
    expect(await readFile(target, 'utf-8')).toBe('x: 1\n');
  });
});
