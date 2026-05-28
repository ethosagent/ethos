import { describe, expect, it, vi } from 'vitest';
import { filterSkill, warnMissingAllowList } from '../ingest-filter';

function makeSkill(overrides = {}) {
  return {
    qualifiedName: 'ethos/my-skill',
    name: 'My Skill',
    source: 'ethos',
    filePath: '/skills/my-skill.md',
    body: '# body',
    rawFrontmatter: {},
    dialect: 'agentskills',
    mtimeMs: 1_000_000,
    ...overrides,
  };
}
function makePersonality(overrides = {}) {
  return {
    id: 'researcher',
    name: 'Researcher',
    toolset: ['read_file', 'search_web'],
    ...overrides,
  };
}
describe('filterSkill', () => {
  describe('capability mode (default)', () => {
    it('includes skill whose required_tools ⊆ toolNames', () => {
      const skill = makeSkill({ required_tools: ['read_file'] });
      const result = filterSkill(skill, makePersonality(), new Set(['read_file', 'search_web']));
      expect(result.include).toBe(true);
    });
    it('excludes skill whose required_tools ⊄ toolNames', () => {
      const skill = makeSkill({ required_tools: ['run_shell'] });
      const result = filterSkill(skill, makePersonality(), new Set(['read_file']));
      expect(result.include).toBe(false);
      expect(result.reason).toContain('run_shell');
    });
    it('includes pure-prose skill (no required_tools) with default fallback', () => {
      const skill = makeSkill({ required_tools: undefined });
      const result = filterSkill(skill, makePersonality(), new Set());
      expect(result.include).toBe(true);
      expect(result.reason).toContain('pure prose');
    });
    it('excludes pure-prose skill when fallback is deny', () => {
      const personality = makePersonality({
        skills: { global_ingest: { mode: 'capability', fallback_unknown: 'deny' } },
      });
      const result = filterSkill(makeSkill(), personality, new Set());
      expect(result.include).toBe(false);
    });
    it('calls onWarn for fallback: warn', () => {
      const warn = vi.fn();
      const personality = makePersonality({
        skills: { global_ingest: { mode: 'capability', fallback_unknown: 'warn' } },
      });
      filterSkill(makeSkill(), personality, new Set(), warn);
      expect(warn).toHaveBeenCalledOnce();
    });
  });
  describe('explicit mode', () => {
    it('excludes all skills not in allow list', () => {
      const personality = makePersonality({
        skills: { global_ingest: { mode: 'explicit', allow: [] } },
      });
      const result = filterSkill(makeSkill(), personality, new Set());
      expect(result.include).toBe(false);
    });
    it('includes skill in allow list', () => {
      const personality = makePersonality({
        skills: { global_ingest: { mode: 'explicit', allow: ['ethos/my-skill'] } },
      });
      const result = filterSkill(makeSkill(), personality, new Set(['read_file']));
      expect(result.include).toBe(true);
    });
    it('rejects allow-listed skill whose required_tools are unreachable', () => {
      const warn = vi.fn();
      const personality = makePersonality({
        skills: { global_ingest: { mode: 'explicit', allow: ['ethos/my-skill'] } },
      });
      const skill = makeSkill({ required_tools: ['run_shell'] });
      const result = filterSkill(skill, personality, new Set(['read_file']), warn);
      expect(result.include).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    });
  });
  describe('deny list', () => {
    it('deny always wins, even over explicit allow', () => {
      const personality = makePersonality({
        skills: {
          global_ingest: {
            mode: 'explicit',
            allow: ['ethos/my-skill'],
            deny: ['ethos/my-skill'],
          },
        },
      });
      const result = filterSkill(makeSkill(), personality, new Set());
      expect(result.include).toBe(false);
      expect(result.reason).toBe('explicit deny');
    });
  });
  describe('tags mode', () => {
    it('includes skill with matching accept_tags', () => {
      const personality = makePersonality({
        skills: {
          global_ingest: { mode: 'tags', accept_tags: ['research'] },
        },
      });
      const skill = makeSkill({ tags: ['research', 'web'] });
      const result = filterSkill(skill, personality, new Set());
      expect(result.include).toBe(true);
    });
    it('excludes skill with no matching accept_tags', () => {
      const personality = makePersonality({
        skills: { global_ingest: { mode: 'tags', accept_tags: ['deploy'] } },
      });
      const skill = makeSkill({ tags: ['research'] });
      const result = filterSkill(skill, personality, new Set());
      expect(result.include).toBe(false);
    });
    it('excludes skill with a reject_tag', () => {
      const personality = makePersonality({
        skills: {
          global_ingest: {
            mode: 'tags',
            accept_tags: ['research'],
            reject_tags: ['ops'],
          },
        },
      });
      const skill = makeSkill({ tags: ['research', 'ops'] });
      const result = filterSkill(skill, personality, new Set());
      expect(result.include).toBe(false);
      expect(result.reason).toContain('ops');
    });
    it('includes untagged skill when no accept_tags configured', () => {
      const personality = makePersonality({
        skills: { global_ingest: { mode: 'tags' } },
      });
      const result = filterSkill(makeSkill({ tags: undefined }), personality, new Set());
      expect(result.include).toBe(true);
    });
  });
  describe('none mode', () => {
    it('always excludes', () => {
      const personality = makePersonality({
        skills: { global_ingest: { mode: 'none' } },
      });
      const result = filterSkill(makeSkill(), personality, new Set());
      expect(result.include).toBe(false);
      expect(result.reason).toBe('mode: none');
    });
  });
  describe('permissions.tools_required enforcement', () => {
    it('excludes skill when permissions.tools_required not in toolNames', () => {
      const skill = makeSkill({
        required_tools: undefined,
        permissions: { tools_required: ['run_shell'] },
      });
      const result = filterSkill(skill, makePersonality(), new Set(['read_file']));
      expect(result.include).toBe(false);
      expect(result.reason).toContain('run_shell');
    });
    it('includes skill when permissions.tools_required are all in toolNames', () => {
      const skill = makeSkill({
        required_tools: ['read_file'],
        permissions: { tools_required: ['search_web'] },
      });
      const result = filterSkill(skill, makePersonality(), new Set(['read_file', 'search_web']));
      expect(result.include).toBe(true);
    });
    it('enforces permissions.tools_required in explicit allow list', () => {
      const personality = makePersonality({
        skills: {
          global_ingest: { mode: 'explicit', allow: ['ethos/my-skill'] },
        },
      });
      const skill = makeSkill({ permissions: { tools_required: ['missing_tool'] } });
      const result = filterSkill(skill, personality, new Set());
      expect(result.include).toBe(false);
      expect(result.reason).toContain('missing_tool');
    });
  });
  describe('allowed_skill_permissions policy enforcement', () => {
    it('warns but allows fs_read/fs_write when no policy is set', () => {
      const warn = vi.fn();
      const skill = makeSkill({ permissions: { fs_read: ['/data'], fs_write: ['/tmp/out'] } });
      const result = filterSkill(skill, makePersonality(), new Set(), warn);
      expect(result.include).toBe(true);
      expect(warn).toHaveBeenCalledTimes(2);
    });
    it('blocks skill declaring fs_read when policy does not allow it', () => {
      const personality = makePersonality({
        safety: { allowed_skill_permissions: {} },
      });
      const skill = makeSkill({ permissions: { fs_read: ['/etc/secret'] } });
      const result = filterSkill(skill, personality, new Set());
      expect(result.include).toBe(false);
      expect(result.reason).toContain('fs_read');
      expect(result.reason).toContain('/etc/secret');
    });
    it('allows fs_read when policy is true', () => {
      const personality = makePersonality({
        safety: { allowed_skill_permissions: { fs_read: true } },
      });
      const skill = makeSkill({ permissions: { fs_read: ['/any/path'] } });
      expect(filterSkill(skill, personality, new Set()).include).toBe(true);
    });
    it('allows fs_read paths that are in the allowlist and blocks those that are not', () => {
      const personality = makePersonality({
        safety: { allowed_skill_permissions: { fs_read: ['/safe'] } },
      });
      const allowed = makeSkill({ permissions: { fs_read: ['/safe'] } });
      expect(filterSkill(allowed, personality, new Set()).include).toBe(true);
      const blocked = makeSkill({ permissions: { fs_read: ['/safe', '/unsafe'] } });
      const r = filterSkill(blocked, personality, new Set());
      expect(r.include).toBe(false);
      expect(r.reason).toContain('/unsafe');
    });
    it('blocks skill declaring fs_write when policy does not allow it', () => {
      const personality = makePersonality({
        safety: { allowed_skill_permissions: { network: true } },
      });
      const skill = makeSkill({ permissions: { fs_write: ['/tmp/out'] } });
      const result = filterSkill(skill, personality, new Set());
      expect(result.include).toBe(false);
      expect(result.reason).toContain('fs_write');
    });
    it('allows fs_write paths in the allowlist, blocks undeclared ones', () => {
      const personality = makePersonality({
        safety: { allowed_skill_permissions: { fs_write: ['/tmp/ethos'] } },
      });
      const ok = makeSkill({ permissions: { fs_write: ['/tmp/ethos'] } });
      expect(filterSkill(ok, personality, new Set()).include).toBe(true);
      const bad = makeSkill({ permissions: { fs_write: ['/tmp/ethos', '/etc/passwd'] } });
      const r = filterSkill(bad, personality, new Set());
      expect(r.include).toBe(false);
      expect(r.reason).toContain('/etc/passwd');
    });
    it('blocks skill declaring network when policy does not allow it', () => {
      const personality = makePersonality({
        safety: { allowed_skill_permissions: {} },
      });
      const skill = makeSkill({ permissions: { network: ['api.example.com'] } });
      const result = filterSkill(skill, personality, new Set());
      expect(result.include).toBe(false);
      expect(result.reason).toContain('api.example.com');
    });
    it('allows declared network hosts in allowlist, blocks undeclared ones', () => {
      const personality = makePersonality({
        safety: { allowed_skill_permissions: { network: ['github.com'] } },
      });
      const ok = makeSkill({ permissions: { network: ['github.com'] } });
      expect(filterSkill(ok, personality, new Set()).include).toBe(true);
      const bad = makeSkill({ permissions: { network: ['github.com', 'evil.com'] } });
      const r = filterSkill(bad, personality, new Set());
      expect(r.include).toBe(false);
      expect(r.reason).toContain('evil.com');
      expect(r.reason).not.toContain('github.com');
    });
    it('allows network: true to pass any host', () => {
      const personality = makePersonality({
        safety: { allowed_skill_permissions: { network: true } },
      });
      const skill = makeSkill({ permissions: { network: ['any.host.example.com'] } });
      expect(filterSkill(skill, personality, new Set()).include).toBe(true);
    });
    it('blocks skill declaring mcp_env_passthrough when policy does not allow it', () => {
      const personality = makePersonality({
        safety: { allowed_skill_permissions: {} },
      });
      const skill = makeSkill({ permissions: { mcp_env_passthrough: ['GITHUB_TOKEN'] } });
      const result = filterSkill(skill, personality, new Set());
      expect(result.include).toBe(false);
      expect(result.reason).toContain('GITHUB_TOKEN');
    });
    it('allows only listed vars in mcp_env_passthrough allowlist', () => {
      const personality = makePersonality({
        safety: { allowed_skill_permissions: { mcp_env_passthrough: ['ALLOWED_VAR'] } },
      });
      const ok = makeSkill({ permissions: { mcp_env_passthrough: ['ALLOWED_VAR'] } });
      expect(filterSkill(ok, personality, new Set()).include).toBe(true);
      const bad = makeSkill({ permissions: { mcp_env_passthrough: ['ALLOWED_VAR', 'SECRET'] } });
      const r = filterSkill(bad, personality, new Set());
      expect(r.include).toBe(false);
      expect(r.reason).toContain('SECRET');
    });
    it('allows mcp_env_passthrough when policy is true', () => {
      const personality = makePersonality({
        safety: { allowed_skill_permissions: { mcp_env_passthrough: true } },
      });
      const skill = makeSkill({ permissions: { mcp_env_passthrough: ['GITHUB_TOKEN'] } });
      expect(filterSkill(skill, personality, new Set()).include).toBe(true);
    });
  });
  describe('fallback_for_tools (E1 — conditional skill availability)', () => {
    it('includes fallback skill when listed tool is absent', () => {
      const skill = makeSkill({
        qualifiedName: 'ethos/local-source-search',
        fallback_for_tools: ['web_search'],
      });
      const personality = makePersonality({ toolset: ['read_file'] });
      const result = filterSkill(skill, personality, new Set(['read_file']));
      expect(result.include).toBe(true);
    });
    it('excludes fallback skill when listed tool is present', () => {
      const skill = makeSkill({
        qualifiedName: 'ethos/local-source-search',
        fallback_for_tools: ['web_search'],
      });
      const personality = makePersonality({ toolset: ['web_search', 'read_file'] });
      const result = filterSkill(skill, personality, new Set(['web_search', 'read_file']));
      expect(result.include).toBe(false);
      expect(result.reason).toContain('web_search');
    });
    it('excludes fallback skill when ANY listed tool is present', () => {
      const skill = makeSkill({
        fallback_for_tools: ['web_search', 'web_extract'],
      });
      const personality = makePersonality({ toolset: ['web_extract'] });
      const result = filterSkill(skill, personality, new Set(['web_extract']));
      expect(result.include).toBe(false);
      expect(result.reason).toContain('web_extract');
    });
    it('includes fallback skill when ALL listed tools are absent', () => {
      const skill = makeSkill({
        fallback_for_tools: ['web_search', 'web_extract'],
      });
      const result = filterSkill(skill, makePersonality({ toolset: [] }), new Set());
      expect(result.include).toBe(true);
    });
    it('honors both required_tools AND fallback_for_tools — both gates apply', () => {
      const skill = makeSkill({
        required_tools: ['read_file'],
        fallback_for_tools: ['web_search'],
      });
      // required satisfied + fallback target absent → include
      const personality = makePersonality({ toolset: ['read_file'] });
      expect(filterSkill(skill, personality, new Set(['read_file'])).include).toBe(true);
      // required satisfied but fallback target present → exclude
      const personality2 = makePersonality({ toolset: ['read_file', 'web_search'] });
      expect(filterSkill(skill, personality2, new Set(['read_file', 'web_search'])).include).toBe(
        false,
      );
    });
    it('applies fallback gate to explicit-allow skills too', () => {
      const skill = makeSkill({
        qualifiedName: 'ethos/local-fallback',
        fallback_for_tools: ['web_search'],
      });
      const personality = makePersonality({
        toolset: ['web_search'],
        skills: { global_ingest: { mode: 'explicit', allow: ['ethos/local-fallback'] } },
      });
      const result = filterSkill(skill, personality, new Set(['web_search']));
      expect(result.include).toBe(false);
      expect(result.reason).toContain('fallback_for_tools active');
    });
    it('applies fallback gate to tags-mode skills too', () => {
      const skill = makeSkill({
        tags: ['research'],
        fallback_for_tools: ['web_search'],
      });
      const personality = makePersonality({
        toolset: ['web_search'],
        skills: { global_ingest: { mode: 'tags', accept_tags: ['research'] } },
      });
      const result = filterSkill(skill, personality, new Set(['web_search']));
      expect(result.include).toBe(false);
      expect(result.reason).toContain('fallback_for_tools active');
    });
  });
});
describe('warnMissingAllowList', () => {
  it('warns for each allow-listed name missing from pool', () => {
    const warn = vi.fn();
    const pool = new Map([['ethos/present', {}]]);
    warnMissingAllowList('researcher', ['ethos/present', 'ethos/missing'], pool, warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('ethos/missing');
  });
  it('does not warn when all referenced skills exist', () => {
    const warn = vi.fn();
    const pool = new Map([
      ['ethos/a', {}],
      ['ethos/b', {}],
    ]);
    warnMissingAllowList('researcher', ['ethos/a', 'ethos/b'], pool, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
