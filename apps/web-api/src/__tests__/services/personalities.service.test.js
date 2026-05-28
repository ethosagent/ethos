import { join } from 'node:path';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { SkillsLibrary } from '@ethosagent/skills';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { PersonalitiesService } from '../../services/personalities.service';
import { makeStubPersonalityRegistry } from '../test-helpers';

// Service tests cover both the repository (via real SOUL.md reads from
// InMemoryStorage) and the wire-shape mapping.
const DATA = '/data';
describe('PersonalitiesService', () => {
  function makeService(opts) {
    const registry = makeStubPersonalityRegistry(opts.personalities, DATA);
    const library = new SkillsLibrary({ dataDir: DATA });
    return new PersonalitiesService({ personalities: registry, library });
  }
  it('list maps PersonalityConfig → wire shape and includes defaultId', () => {
    const service = makeService({
      personalities: [
        {
          id: 'researcher',
          name: 'Researcher',
          description: 'curious + careful',
          model: 'claude-opus-4-7',
          // soulFile lives outside the user dir → built-in
          soulFile: '/usr/share/ethos/personalities/researcher/SOUL.md',
        },
      ],
    });
    const result = service.list();
    expect(result.defaultId).toBe('researcher');
    expect(result.items).toHaveLength(1);
    const p = result.items[0];
    if (!p) throw new Error('expected one personality');
    expect(p.id).toBe('researcher');
    expect(p.builtin).toBe(true);
    // Server-internal fields are stripped
    expect('soulFile' in p).toBe(false);
    expect('skillsDirs' in p).toBe(false);
  });
  it('marks user personalities as builtin: false based on soulFile path', () => {
    const userSoulFile = join(DATA, 'personalities', 'custom', 'SOUL.md');
    const service = makeService({
      personalities: [
        { id: 'custom', name: 'Custom', soulFile: userSoulFile },
        // No soulFile → treated as built-in (config-only personalities are built-ins by default)
        { id: 'builtin', name: 'Built-in' },
      ],
    });
    const result = service.list();
    const byId = Object.fromEntries(result.items.map((p) => [p.id, p]));
    expect(byId.custom?.builtin).toBe(false);
    expect(byId.builtin?.builtin).toBe(true);
  });
  it('get returns personality + reads SOUL.md body from disk', async () => {
    const storage = new InMemoryStorage();
    const soulPath = join(DATA, 'personalities', 'researcher', 'SOUL.md');
    await storage.mkdir(join(DATA, 'personalities', 'researcher'));
    await storage.write(soulPath, '# Researcher\n\nI am a careful researcher.\n');
    const registry = new FilePersonalityRegistry(storage, DATA);
    registry.define({ id: 'researcher', name: 'Researcher', soulFile: soulPath });
    registry.setDefault('researcher');
    const library = new SkillsLibrary({ dataDir: DATA, storage });
    const service = new PersonalitiesService({ personalities: registry, library });
    const result = await service.get('researcher');
    expect(result.personality.id).toBe('researcher');
    expect(result.soulMd).toContain('I am a careful researcher.');
    // soulFile under DATA/personalities/ → user-owned → builtin: false
    expect(result.personality.builtin).toBe(false);
  });
  it('get throws PERSONALITY_NOT_FOUND for unknown ids', async () => {
    const service = makeService({ personalities: [] });
    await expect(service.get('nope')).rejects.toMatchObject({ code: 'PERSONALITY_NOT_FOUND' });
  });
  it('get returns empty soulMd when file is missing', async () => {
    const service = makeService({
      personalities: [
        {
          id: 'researcher',
          name: 'Researcher',
          soulFile: join(DATA, 'personalities', 'researcher', 'SOUL.md'),
        },
      ],
    });
    const result = await service.get('researcher');
    expect(result.soulMd).toBe('');
  });
  it('characterSheet renders the Markdown artifact from config + SOUL.md', async () => {
    const storage = new InMemoryStorage();
    const soulPath = join(DATA, 'personalities', 'researcher', 'SOUL.md');
    await storage.mkdir(join(DATA, 'personalities', 'researcher'));
    await storage.write(soulPath, '# Researcher\n\nI am a careful researcher.\n');
    const registry = new FilePersonalityRegistry(storage, DATA);
    registry.define({
      id: 'researcher',
      name: 'Researcher',
      model: 'claude-opus-4-7',
      soulFile: soulPath,
    });
    registry.setDefault('researcher');
    const library = new SkillsLibrary({ dataDir: DATA, storage });
    const service = new PersonalitiesService({ personalities: registry, library });
    const { markdown } = await service.characterSheet('researcher');
    expect(markdown).toMatch(/^# researcher — Researcher$/m);
    expect(markdown).toContain('I am a careful researcher.');
    expect(markdown).toContain('claude-opus-4-7');
  });
  it('characterSheet throws PERSONALITY_NOT_FOUND for unknown ids', async () => {
    const service = makeService({ personalities: [] });
    await expect(service.characterSheet('nope')).rejects.toMatchObject({
      code: 'PERSONALITY_NOT_FOUND',
    });
  });
  // -------------------------------------------------------------------------
  // MCP per-server tool subsets — mcp.yaml persistence + read-back. Mirrors
  // what the personalities.update RPC handler does when `mcp_servers` and
  // `mcp_tools` are both present.
  // -------------------------------------------------------------------------
  describe('MCP tool subsets', () => {
    async function makeMcpService() {
      const storage = new InMemoryStorage();
      const registry = new FilePersonalityRegistry(storage, DATA);
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      const service = new PersonalitiesService({ personalities: registry, library });
      // A real user personality, so writes land on InMemoryStorage.
      await service.create({
        id: 'agent',
        name: 'Agent',
        toolset: [],
        soulMd: '# Agent',
        mcp_servers: ['linear', 'slack'],
      });
      return { service, storage };
    }
    // Replicates the RPC handler's `mcp_servers` + `mcp_tools` → subsets map.
    function buildSubsets(mcpServers, mcpTools) {
      const subsets = {};
      for (const server of mcpServers) subsets[server] = mcpTools[server] ?? null;
      return subsets;
    }
    it('persists a strict subset and clears all-selected servers', async () => {
      const { service, storage } = await makeMcpService();
      // linear → strict subset; slack → all tools (omitted from mcp_tools).
      await service.writeMcpToolSubsets(
        'agent',
        buildSubsets(['linear', 'slack'], { linear: ['list_issues'] }),
      );
      const yaml = await storage.read(join(DATA, 'personalities', 'agent', 'mcp.yaml'));
      expect(yaml).toContain('linear:');
      expect(yaml).toContain('- list_issues');
      // slack got `null` → no tools key → not present (default-allow).
      expect(yaml).not.toContain('slack:');
      const { mcpPolicy } = await service.get('agent');
      expect(mcpPolicy?.servers?.linear?.tools).toEqual(['list_issues']);
      expect(mcpPolicy?.servers?.slack).toBeUndefined();
    });
    it('get returns mcpPolicy: null when the personality has no mcp.yaml', async () => {
      const { service } = await makeMcpService();
      const { mcpPolicy } = await service.get('agent');
      expect(mcpPolicy).toBeNull();
    });
    it('preserves reject_args across a subsequent subset edit', async () => {
      // Seed a personality dir that already has an mcp.yaml carrying
      // reject_args, then load it so the registry's policy cache is warm.
      const storage = new InMemoryStorage();
      const dir = join(DATA, 'personalities', 'agent');
      await storage.mkdir(dir);
      await storage.write(join(dir, 'config.yaml'), 'name: Agent\nmcp_servers: linear\n');
      await storage.write(join(dir, 'SOUL.md'), '# Agent');
      await storage.write(
        join(dir, 'mcp.yaml'),
        [
          'servers:',
          '  linear:',
          '    tools:',
          '      - list_issues',
          '      - save_issue',
          '    reject_args:',
          '      save_issue:',
          '        status:',
          '          - Done',
        ].join('\n'),
      );
      const registry = new FilePersonalityRegistry(storage, DATA);
      await registry.loadFromDirectory(join(DATA, 'personalities'));
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      const service = new PersonalitiesService({ personalities: registry, library });
      await service.writeMcpToolSubsets(
        'agent',
        buildSubsets(['linear'], { linear: ['list_issues'] }),
      );
      const { mcpPolicy } = await service.get('agent');
      expect(mcpPolicy?.servers?.linear?.tools).toEqual(['list_issues']);
      expect(mcpPolicy?.servers?.linear?.reject_args?.save_issue?.status).toEqual(['Done']);
    });
  });
});
