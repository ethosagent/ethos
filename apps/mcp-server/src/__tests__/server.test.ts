import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { claudeDesktop } from '../clients/claude-desktop';
import { continueClient } from '../clients/continue';
import { cursor } from '../clients/cursor';
import { opencode } from '../clients/opencode';
import { zed } from '../clients/zed';
import { getPromptMessages, PROMPTS } from '../prompts';
import { listResources } from '../resources';
import { listPersonalities } from '../tools/list-personalities';

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

describe('listResources', () => {
  it('lists sessions and personality files through Storage', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/data/personalities/reviewer');
    await storage.write('/data/personalities/reviewer/SOUL.md', '# soul');
    await storage.write('/data/personalities/reviewer/config.yaml', 'name: Reviewer\n');
    const uris = (await listResources({ dataDir: '/data', storage })).map((r) => r.uri);
    expect(uris).toContain('ethos://sessions/recent');
    expect(uris).toContain('ethos://personalities/reviewer/SOUL.md');
    expect(uris).toContain('ethos://personalities/reviewer/config.yaml');
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
