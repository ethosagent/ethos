// F04 follow-up — a `memory: vault` deployment keeps its memory OUTSIDE
// `<dataDir>`, and the archive's scope table is dataDir-relative (`scopes.ts`),
// so neither the vault's content nor its `.ethos-meta/` provenance is in any
// backup. Including an arbitrary external path in the archive format is a
// design change; what a backup MUST do meanwhile is say so and name the path.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBackup } from '../create';
import { externalMemoryNotice } from '../external-memory';

describe('externalMemoryNotice', () => {
  it('names the vault content and provenance paths under memory: vault', () => {
    const notice = externalMemoryNotice({
      memory: 'vault',
      memoryVault: { path: '/Users/me/Vault' },
    });
    expect(notice).not.toBeNull();
    expect(notice?.path).toBe('/Users/me/Vault/Ethos');
    expect(notice?.metaPath).toBe('/Users/me/Vault/Ethos/.ethos-meta');
    expect(notice?.message).toContain('/Users/me/Vault/Ethos');
    expect(notice?.message).toContain('NOT');
  });

  it('honours memoryVault.agentDir', () => {
    expect(
      externalMemoryNotice({
        memory: 'vault',
        memoryVault: { path: '/v', agentDir: 'Agent' },
      })?.path,
    ).toBe('/v/Agent');
  });

  it('is silent for markdown and vector, and for a vault with no path', () => {
    expect(externalMemoryNotice({})).toBeNull();
    expect(externalMemoryNotice({ memory: 'markdown' })).toBeNull();
    expect(externalMemoryNotice({ memory: 'vector' })).toBeNull();
    expect(externalMemoryNotice({ memory: 'vault' })).toBeNull();
  });
});

describe('createBackup reports the excluded vault', () => {
  it('carries the notice on the result so every surface can print it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ethos-backup-external-memory-'));
    try {
      const dataDir = join(root, '.ethos');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'config.yaml'), 'provider: anthropic\nmodel: m\n');
      const result = await createBackup({
        dataDir,
        outPath: join(root, 'out.tar.gz'),
        scopes: ['identity'],
        memory: { memory: 'vault', memoryVault: { path: join(root, 'vault') } },
      });
      expect(result.externalMemory?.path).toBe(join(root, 'vault', 'Ethos'));

      const without = await createBackup({
        dataDir,
        outPath: join(root, 'out2.tar.gz'),
        scopes: ['identity'],
      });
      expect(without.externalMemory).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
