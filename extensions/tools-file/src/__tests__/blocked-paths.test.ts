// Containment 3a — write_file / patch_file name the refusal when a turn tries
// to rewrite a personality's own definition. The ENFORCER is the boundary
// (`ScopedFsImpl`'s write-deny list); `isPersonalityDefinitionPath` is defence
// in depth with a better message. Both are exercised: with `ETHOS_STATE_DIR`
// pointing at the data dir the tool's own check fires first; without it the
// boundary refuses and the tool still reports the named error, not a generic
// "outside fs_reach".

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { personalityWriteDeny, ScopedFsImpl } from '@ethosagent/core';
import { defaultAlwaysDeny, FsStorage } from '@ethosagent/storage-fs';
import type { ToolContext, ToolResult } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPersonalityDefinitionPath, patchFileTool, writeFileTool } from '../index';

describe('tools-file — personality definition files are operator-owned', () => {
  let dataDir: string;
  let own: string;

  beforeEach(async () => {
    dataDir = await realpath(await mkdtemp(join(tmpdir(), 'ethos-defn-')));
    own = join(dataDir, 'personalities', 'bob');
    await mkdir(join(own, 'files'), { recursive: true });
    await writeFile(join(own, 'toolset.yaml'), '- read_file\n');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dataDir, { recursive: true, force: true });
  });

  function ctx(): ToolContext {
    const reach = new Set([`${own}/`]);
    return {
      sessionId: 's',
      sessionKey: 'cli:defn',
      platform: 'cli',
      workingDir: own,
      currentTurn: 1,
      messageCount: 1,
      abortSignal: new AbortController().signal,
      emit: () => {},
      resultBudgetChars: 80_000,
      personalityId: 'bob',
      scopedFs: new ScopedFsImpl(
        new FsStorage(),
        reach,
        reach,
        defaultAlwaysDeny(),
        personalityWriteDeny(dataDir, 'bob'),
      ),
    };
  }

  function expectNamedRefusal(result: ToolResult): void {
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('personality definition is operator-owned');
  }

  for (const withStateDir of [true, false]) {
    describe(withStateDir ? 'tool check (ETHOS_STATE_DIR set)' : 'boundary check', () => {
      beforeEach(() => {
        if (withStateDir) vi.stubEnv('ETHOS_STATE_DIR', dataDir);
      });

      it('write_file on personalities/<self>/toolset.yaml returns the named error', async () => {
        const result = await writeFileTool.execute(
          { path: join(own, 'toolset.yaml'), content: '- terminal\n' },
          ctx(),
        );
        expectNamedRefusal(result);
        expect(await readFile(join(own, 'toolset.yaml'), 'utf8')).toBe('- read_file\n');
      });

      it('patch_file on personalities/<self>/toolset.yaml returns the named error', async () => {
        const result = await patchFileTool.execute(
          { path: join(own, 'toolset.yaml'), old_text: 'read_file', new_text: 'terminal' },
          ctx(),
        );
        expectNamedRefusal(result);
        expect(await readFile(join(own, 'toolset.yaml'), 'utf8')).toBe('- read_file\n');
      });

      it('personalities/<self>/files/x.md is allowed', async () => {
        const result = await writeFileTool.execute(
          { path: join(own, 'files', 'x.md'), content: 'note' },
          ctx(),
        );
        expect(result.ok).toBe(true);
      });
    });
  }

  it('isPersonalityDefinitionPath matches every definition entry and nothing else', () => {
    vi.stubEnv('ETHOS_STATE_DIR', dataDir);
    for (const entry of ['SOUL.md', 'config.yaml', 'toolset.yaml', 'mcp.yaml', 'tools.yaml']) {
      expect(isPersonalityDefinitionPath(join(own, entry))).toBe(true);
    }
    expect(isPersonalityDefinitionPath(join(own, 'ETHOS.md'))).toBe(true);
    expect(isPersonalityDefinitionPath(join(own, 'skills', 'x', 'SKILL.md'))).toBe(true);
    expect(isPersonalityDefinitionPath(join(dataDir, 'personalities', 'other', 'SOUL.md'))).toBe(
      true,
    );
    expect(isPersonalityDefinitionPath(join(own, 'files', 'toolset.yaml'))).toBe(false);
    expect(isPersonalityDefinitionPath(join(own, 'MEMORY.md'))).toBe(false);
    expect(isPersonalityDefinitionPath(join(dataDir, 'toolset.yaml'))).toBe(false);
  });
});
