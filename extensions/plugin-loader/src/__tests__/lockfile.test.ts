import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeIntegrity,
  type PluginLockfile,
  readLockfile,
  verifyIntegrity,
  writeLockfile,
} from '../lockfile';

// ---------------------------------------------------------------------------
// Lockfile read / write
// ---------------------------------------------------------------------------

describe('lockfile read/write', () => {
  let storage: InMemoryStorage;
  const personalityDir = '/personalities/trader';

  beforeEach(async () => {
    storage = new InMemoryStorage();
    await storage.mkdir(personalityDir);
  });

  it('returns empty object when no lockfile exists', async () => {
    const result = await readLockfile(storage, personalityDir);
    expect(result).toEqual({});
  });

  it('round-trips a single-plugin lockfile', async () => {
    const lockfile: PluginLockfile = {
      'tools-zerodha': {
        package: '@ethos-plugins/tools-zerodha',
        version: '1.4.2',
        registry: 'https://registry.npmjs.org',
        integrity: 'sha512-abc123',
      },
    };

    await writeLockfile(storage, personalityDir, lockfile);
    const result = await readLockfile(storage, personalityDir);
    expect(result).toEqual(lockfile);
  });

  it('handles multiple plugins', async () => {
    const lockfile: PluginLockfile = {
      'tools-zerodha': {
        package: '@ethos-plugins/tools-zerodha',
        version: '1.4.2',
        registry: 'https://registry.npmjs.org',
        integrity: 'sha512-abc123',
      },
      'tools-telegram': {
        package: '@ethos-plugins/tools-telegram',
        version: '2.0.0',
        registry: 'https://registry.npmjs.org',
        integrity: 'sha512-def456',
      },
    };

    await writeLockfile(storage, personalityDir, lockfile);
    const result = await readLockfile(storage, personalityDir);
    expect(result).toEqual(lockfile);
  });

  it('preserves custom registry URLs', async () => {
    const lockfile: PluginLockfile = {
      'internal-tool': {
        package: '@company/internal-tool',
        version: '0.1.0',
        registry: 'https://npm.internal.company.com',
        integrity: 'sha512-xyz789',
      },
    };

    await writeLockfile(storage, personalityDir, lockfile);
    const result = await readLockfile(storage, personalityDir);
    expect(result['internal-tool']?.registry).toBe('https://npm.internal.company.com');
  });
});

// ---------------------------------------------------------------------------
// Integrity verification
// ---------------------------------------------------------------------------

describe('integrity verification', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `ethos-integrity-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('computes sha512 integrity string', async () => {
    const content = 'hello world';
    const filePath = join(tempDir, 'test.tgz');
    await writeFile(filePath, content);

    const integrity = await computeIntegrity(filePath);

    expect(integrity).toMatch(/^sha512-/);

    // Verify against known hash
    const expected = createHash('sha512').update(content).digest('base64');
    expect(integrity).toBe(`sha512-${expected}`);
  });

  it('verifies matching integrity returns true', async () => {
    const content = 'plugin tarball content';
    const filePath = join(tempDir, 'plugin.tgz');
    await writeFile(filePath, content);

    const integrity = await computeIntegrity(filePath);
    const result = await verifyIntegrity(filePath, integrity);

    expect(result).toBe(true);
  });

  it('rejects mismatched integrity returns false', async () => {
    const filePath = join(tempDir, 'plugin.tgz');
    await writeFile(filePath, 'real content');

    const result = await verifyIntegrity(filePath, 'sha512-bogus');

    expect(result).toBe(false);
  });
});
