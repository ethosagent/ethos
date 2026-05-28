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
import { searchMemory } from '../tools/search-memory';

function makeTmpDir() {
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
  it('returns empty array when files absent', () => {
    const dir = makeTmpDir();
    expect(searchMemory(dir, 'hello')).toEqual([]);
  });
  it('finds matching lines in MEMORY.md', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'MEMORY.md'), 'line one\nthe keyword line\nline three\n');
    const results = searchMemory(dir, 'keyword');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.snippet).toContain('keyword');
  });
  it('scopes to user file when scope=user', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'MEMORY.md'), 'secret in memory\n');
    writeFileSync(join(dir, 'USER.md'), 'secret in user\n');
    const results = searchMemory(dir, 'secret', 'user');
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
    expect(cfg.mcpServers.ethos).toBeDefined();
  });
  it('cursor injectEntry puts entry in mcpServers', () => {
    const cfg = cursor.injectEntry({}, { command: 'node', args: ['serve'] });
    expect(cfg.mcpServers.ethos).toBeDefined();
  });
  it('opencode injectEntry puts entry in mcp.servers', () => {
    const cfg = opencode.injectEntry({}, { command: 'node', args: ['serve'] });
    const servers = cfg.mcp.servers;
    expect(servers.ethos).toBeDefined();
  });
  it('continue injectEntry appends to mcpServers array', () => {
    const cfg = continueClient.injectEntry({}, { command: 'node', args: ['serve'] });
    const servers = cfg.mcpServers;
    expect(servers.some((s) => s.name === 'ethos')).toBe(true);
  });
  it('zed injectEntry puts entry in context_servers', () => {
    const cfg = zed.injectEntry({}, { command: 'node', args: ['serve'] });
    expect(cfg.context_servers.ethos).toBeDefined();
  });
  it('continue injectEntry replaces existing ethos entry', () => {
    const existing = { mcpServers: [{ name: 'ethos', command: 'old', args: [] }] };
    const cfg = continueClient.injectEntry(existing, { command: 'new', args: ['serve'] });
    const servers = cfg.mcpServers;
    expect(servers.filter((s) => s.name === 'ethos')).toHaveLength(1);
    expect(servers.find((s) => s.name === 'ethos')?.command).toBe('new');
  });
});
