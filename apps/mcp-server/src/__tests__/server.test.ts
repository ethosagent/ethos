import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeDesktop } from '../clients/claude-desktop';
import { continueClient } from '../clients/continue';
import { cursor } from '../clients/cursor';
import { opencode } from '../clients/opencode';
import { zed } from '../clients/zed';
import { getPromptMessages, PROMPTS } from '../prompts';
import { listResources } from '../resources';
import { listPersonalities } from '../tools/list-personalities';
import { readMemory } from '../tools/read-memory';
import { searchMemory } from '../tools/search-memory';
import { writeMemory } from '../tools/write-memory';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ethos-mcp-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('listPersonalities', () => {
  it('returns an array (even when dirs are absent)', () => {
    const dir = makeTmpDir();
    const result = listPersonalities(dir);
    expect(Array.isArray(result)).toBe(true);
  });

  it('loads personalities from user dir', () => {
    const dir = makeTmpDir();
    const pDir = join(dir, 'personalities', 'test-pers');
    mkdirSync(pDir, { recursive: true });
    writeFileSync(join(pDir, 'config.yaml'), 'name: Test\ndescription: A test personality\n');
    writeFileSync(join(pDir, 'toolset.yaml'), '- read_file\n- bash\n');
    const result = listPersonalities(dir);
    const p = result.find((x) => x.id === 'test-pers');
    expect(p).toBeDefined();
    expect(p?.name).toBe('Test');
    expect(p?.tools).toContain('read_file');
  });
});

describe('searchMemory', () => {
  it('returns empty array when files absent', async () => {
    const dir = makeTmpDir();
    expect(await searchMemory(dir, 'hello')).toEqual([]);
  });

  it('finds matching lines in MEMORY.md', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'MEMORY.md'), 'line one\nthe keyword line\nline three\n');
    const results = await searchMemory(dir, 'keyword');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.snippet).toContain('keyword');
  });

  it('scopes to user file when scope=user', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'MEMORY.md'), 'secret in memory\n');
    writeFileSync(join(dir, 'USER.md'), 'secret in user\n');
    const results = await searchMemory(dir, 'secret', 'user');
    expect(results.every((r) => r.store === 'user')).toBe(true);
  });
});

describe('listResources', () => {
  it('includes memory resources when files exist', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'MEMORY.md'), '# memory');
    writeFileSync(join(dir, 'USER.md'), '# user');
    const resources = listResources(dir);
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain('ethos://memory/MEMORY.md');
    expect(uris).toContain('ethos://memory/USER.md');
    expect(uris).toContain('ethos://sessions/recent');
  });
});

describe('prompts', () => {
  it('has 4 prompts', () => {
    expect(PROMPTS).toHaveLength(4);
  });

  it('getPromptMessages returns user message for code_review', () => {
    const msgs = getPromptMessages('code_review', { code: 'const x = 1' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe('user');
    expect(msgs[0]?.content.text).toContain('const x = 1');
  });

  it('throws for unknown prompt', () => {
    expect(() => getPromptMessages('nonexistent', {})).toThrow('Unknown prompt');
  });
});

describe('client adapters', () => {
  it('claude-desktop injectEntry puts entry in mcpServers', () => {
    const cfg = claudeDesktop.injectEntry({}, { command: 'node', args: ['serve'] });
    expect((cfg.mcpServers as Record<string, unknown>).ethos).toBeDefined();
  });

  it('cursor injectEntry puts entry in mcpServers', () => {
    const cfg = cursor.injectEntry({}, { command: 'node', args: ['serve'] });
    expect((cfg.mcpServers as Record<string, unknown>).ethos).toBeDefined();
  });

  it('opencode injectEntry puts entry in mcp.servers', () => {
    const cfg = opencode.injectEntry({}, { command: 'node', args: ['serve'] });
    const servers = (cfg.mcp as Record<string, unknown>).servers as Record<string, unknown>;
    expect(servers.ethos).toBeDefined();
  });

  it('continue injectEntry appends to mcpServers array', () => {
    const cfg = continueClient.injectEntry({}, { command: 'node', args: ['serve'] });
    const servers = cfg.mcpServers as Array<Record<string, unknown>>;
    expect(servers.some((s) => s.name === 'ethos')).toBe(true);
  });

  it('zed injectEntry puts entry in context_servers', () => {
    const cfg = zed.injectEntry({}, { command: 'node', args: ['serve'] });
    expect((cfg.context_servers as Record<string, unknown>).ethos).toBeDefined();
  });

  it('continue injectEntry replaces existing ethos entry', () => {
    const existing = { mcpServers: [{ name: 'ethos', command: 'old', args: [] }] };
    const cfg = continueClient.injectEntry(existing, { command: 'new', args: ['serve'] });
    const servers = cfg.mcpServers as Array<Record<string, unknown>>;
    expect(servers.filter((s) => s.name === 'ethos')).toHaveLength(1);
    expect(servers.find((s) => s.name === 'ethos')?.command).toBe('new');
  });
});

function mockProvider(overrides: Partial<Parameters<typeof readMemory>[0]> = {}) {
  return {
    prefetch: async (_ctx: unknown) => null,
    read: async (_key: string, _ctx: unknown) => null,
    search: async (_query: string, _ctx: unknown, _opts?: unknown) => [],
    sync: async (_updates: unknown[], _ctx: unknown) => {},
    list: async (_ctx: unknown, _opts?: unknown) => [],
    ...overrides,
  } as Parameters<typeof readMemory>[0];
}

describe('readMemory', () => {
  it('returns content from provider', async () => {
    const provider = mockProvider({
      read: async (key: string, _ctx: unknown) => ({ key, content: `content of ${key}` }),
    });
    const result = await readMemory(provider, 'MEMORY.md');
    expect(result).toBe('content of MEMORY.md');
  });

  it('returns not-found message when key is absent', async () => {
    const provider = mockProvider();
    const result = await readMemory(provider, 'missing.md');
    expect(result).toContain('No content found');
  });
});

describe('writeMemory', () => {
  it('calls provider.sync with add action', async () => {
    const synced: unknown[] = [];
    const provider = mockProvider({
      sync: async (updates: unknown[], _ctx: unknown) => {
        synced.push(...(updates as unknown[]));
      },
    });
    const result = await writeMemory(provider, 'add', 'MEMORY.md', 'new content');
    expect(result).toContain('Memory updated');
    expect(synced).toHaveLength(1);
  });

  it('rejects add without content', async () => {
    const provider = mockProvider();
    const result = await writeMemory(provider, 'add', 'MEMORY.md');
    expect(result).toContain('input_invalid');
  });

  it('rejects remove without substring_match', async () => {
    const provider = mockProvider();
    const result = await writeMemory(provider, 'remove', 'MEMORY.md');
    expect(result).toContain('input_invalid');
  });

  it('allows replace with empty string content', async () => {
    const synced: unknown[] = [];
    const provider = mockProvider({
      sync: async (updates: unknown[], _ctx: unknown) => {
        synced.push(...(updates as unknown[]));
      },
    });
    const result = await writeMemory(provider, 'replace', 'MEMORY.md', '');
    expect(result).toContain('Memory updated');
    expect(synced).toHaveLength(1);
  });

  it('handles delete action', async () => {
    const synced: unknown[] = [];
    const provider = mockProvider({
      sync: async (updates: unknown[], _ctx: unknown) => {
        synced.push(...(updates as unknown[]));
      },
    });
    const result = await writeMemory(provider, 'delete', 'MEMORY.md');
    expect(result).toContain('Memory updated');
  });
});

describe('searchMemory with provider', () => {
  it('uses provider.search and filters by scope', async () => {
    const provider = mockProvider({
      search: async (_query: string, _ctx: unknown, _opts?: unknown) => [
        { key: 'MEMORY.md', content: 'project notes' },
        { key: 'USER.md', content: 'user info' },
      ],
    });
    const dir = makeTmpDir();
    const memoryOnly = await searchMemory(dir, 'test', 'memory', provider);
    expect(memoryOnly.every((r) => r.store === 'memory')).toBe(true);

    const userOnly = await searchMemory(dir, 'test', 'user', provider);
    expect(userOnly.every((r) => r.store === 'user')).toBe(true);

    const all = await searchMemory(dir, 'test', 'all', provider);
    expect(all.length).toBe(2);
  });
});
