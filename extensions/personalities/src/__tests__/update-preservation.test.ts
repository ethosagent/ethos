// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal `${self}` tokens — not template interpolation.
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilePersonalityRegistry } from '../index';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-preserve-${Date.now()}-${randomBytes(4).toString('hex')}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeRegistry(): FilePersonalityRegistry {
  return new FilePersonalityRegistry(new FsStorage(), testDir);
}

describe('update preserves unmodified fields', () => {
  it('updating only name preserves all other fields', async () => {
    const id = 'preserve-test';
    const dir = join(testDir, 'personalities', id);
    await mkdir(dir, { recursive: true });
    const configLines = [
      'name: Original',
      'description: A thorough test personality',
      'model: claude-opus-4-7',
      'provider: anthropic',
      'capabilities: triage, release',
      'mcp_servers: github sentry',
      'plugins: linear jira',
      'fs_reach.read: /data, ${self}/docs',
      'fs_reach.write: /data/output',
    ];
    await writeFile(join(dir, 'config.yaml'), `${configLines.join('\n')}\n`);
    await writeFile(join(dir, 'SOUL.md'), '# Preserve\n\nIdentity.\n');
    await writeFile(join(dir, 'toolset.yaml'), '- read_file\n- write_file\n');

    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    // Verify initial state
    const before = registry.get(id);
    expect(before?.name).toBe('Original');
    expect(before?.description).toBe('A thorough test personality');
    expect(before?.model).toBe('claude-opus-4-7');
    expect(before?.provider).toBe('anthropic');
    expect(before?.capabilities).toEqual(['triage', 'release']);
    expect(before?.mcp_servers).toEqual(['github', 'sentry']);
    expect(before?.plugins).toEqual(['linear', 'jira']);
    expect(before?.fs_reach?.read).toEqual(['/data', '${self}/docs']);
    expect(before?.fs_reach?.write).toEqual(['/data/output']);

    // Update ONLY the name
    await registry.update(id, { name: 'New Name' });

    // Re-load into a fresh registry
    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const after = fresh.get(id);

    expect(after?.name).toBe('New Name');
    expect(after?.description).toBe('A thorough test personality');
    expect(after?.model).toBe('claude-opus-4-7');
    expect(after?.provider).toBe('anthropic');
    expect(after?.capabilities).toEqual(['triage', 'release']);
    expect(after?.mcp_servers).toEqual(['github', 'sentry']);
    expect(after?.plugins).toEqual(['linear', 'jira']);
    expect(after?.fs_reach?.read).toEqual(['/data', '${self}/docs']);
    expect(after?.fs_reach?.write).toEqual(['/data/output']);
  });
});
