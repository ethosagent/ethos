// B-T8: the MCP memory surface read the wrong file with raw `node:fs`.
//
// It read `~/.ethos/MEMORY.md` and `~/.ethos/USER.md`, but personality memory
// lives at `~/.ethos/personalities/<id>/` (`resolveScopeDir`,
// extensions/memory-markdown/src/index.ts) — and the provider paths passed
// `scopeId: 'memory'`, which that same function rejects. Every call now names a
// personality and goes through the provider wiring builds.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { MemoryProvider } from '@ethosagent/types';
import { createMemoryProviderFromConfig } from '@ethosagent/wiring';
import { beforeEach, describe, expect, it } from 'vitest';
import { listResources, readResource } from '../resources';
import { readMemory } from '../tools/read-memory';
import { searchMemory } from '../tools/search-memory';
import { writeMemory } from '../tools/write-memory';

const DATA = '/data';

let storage: InMemoryStorage;
let provider: MemoryProvider;

beforeEach(async () => {
  storage = new InMemoryStorage();
  // The same call `ethos mcp serve` makes (apps/ethos/src/commands/mcp.ts).
  provider = createMemoryProviderFromConfig({ config: {}, dataDir: DATA, storage }).provider;
  await storage.mkdir(`${DATA}/personalities/reviewer`);
  await storage.write(
    `${DATA}/personalities/reviewer/MEMORY.md`,
    'line one\nthe keyword line\nline three\n',
  );
  await storage.write(`${DATA}/personalities/reviewer/USER.md`, 'prefers terse review notes\n');
});

describe('search_memory', () => {
  it('finds a line in the personality scope, not in ~/.ethos', async () => {
    const results = await searchMemory(provider, 'reviewer', 'keyword');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.key).toBe('MEMORY.md');
    expect(results[0]?.snippet).toContain('keyword');
  });

  it('does not read another personality memory', async () => {
    await storage.mkdir(`${DATA}/personalities/coach`);
    await storage.write(`${DATA}/personalities/coach/MEMORY.md`, 'the keyword line\n');
    const results = await searchMemory(provider, 'reviewer', 'keyword');
    expect(results.every((r) => r.snippet.includes('keyword'))).toBe(true);
    expect(results).toHaveLength(1);
  });

  it('scope=user restricts to USER.md', async () => {
    expect(await searchMemory(provider, 'reviewer', 'keyword', 'user')).toEqual([]);
    const user = await searchMemory(provider, 'reviewer', 'terse', 'user');
    expect(user[0]?.key).toBe('USER.md');
  });

  it('an unsafe personality id is refused before the provider sees it', async () => {
    await expect(searchMemory(provider, '../..', 'keyword')).rejects.toThrow();
  });
});

describe('read_memory / write_memory', () => {
  it('reads a key from the personality scope', async () => {
    expect(await readMemory(provider, 'reviewer', 'MEMORY.md')).toContain('the keyword line');
  });

  it('writes into the personality directory, where the agent reads', async () => {
    await writeMemory(provider, 'reviewer', 'add', 'MEMORY.md', 'appended line');
    expect(await storage.read(`${DATA}/personalities/reviewer/MEMORY.md`)).toContain(
      'appended line',
    );
    // Never at the old (wrong) location.
    expect(await storage.read(`${DATA}/MEMORY.md`)).toBeNull();
  });

  it('still refuses a malformed write', async () => {
    expect(await writeMemory(provider, 'reviewer', 'add', 'MEMORY.md')).toContain('input_invalid');
    expect(await writeMemory(provider, 'reviewer', 'remove', 'MEMORY.md', 'x')).toContain(
      'input_invalid',
    );
  });
});

describe('memory resources', () => {
  it('lists one URI per personality memory key', async () => {
    const uris = (await listResources({ dataDir: DATA, storage, memoryProvider: provider })).map(
      (r) => r.uri,
    );
    expect(uris).toContain('ethos://memory/reviewer/MEMORY.md');
    expect(uris).toContain('ethos://memory/reviewer/USER.md');
    expect(uris).toContain('ethos://sessions/recent');
  });

  it('lists no memory resources without a provider', async () => {
    const uris = (await listResources({ dataDir: DATA, storage })).map((r) => r.uri);
    expect(uris.some((u) => u.startsWith('ethos://memory/'))).toBe(false);
  });

  it('reads a memory URI through the provider', async () => {
    const text = await readResource('ethos://memory/reviewer/MEMORY.md', {
      dataDir: DATA,
      storage,
      memoryProvider: provider,
    });
    expect(text).toContain('the keyword line');
  });

  it('refuses an unknown URI', async () => {
    await expect(readResource('ethos://nope', { dataDir: DATA, storage })).rejects.toThrow(
      'Unknown resource URI',
    );
  });
});

describe('no raw filesystem access remains', () => {
  const src = join(import.meta.dirname, '..');
  for (const file of [
    'resources.ts',
    'tools/search-memory.ts',
    'tools/read-memory.ts',
    'tools/write-memory.ts',
  ]) {
    it(`${file} imports no node:fs`, () => {
      expect(readFileSync(join(src, file), 'utf8')).not.toMatch(/from 'node:fs/);
    });
  }
});

describe('ethos mcp serve wires the provider', () => {
  it('passes a memoryProvider, so read_memory and write_memory are listed', () => {
    const source = readFileSync(
      join(import.meta.dirname, '../../../ethos/src/commands/mcp.ts'),
      'utf8',
    );
    expect(source).toContain('memoryProvider: memory.provider');
    expect(source).toContain('enableMemoryWrite: true');
  });
});
