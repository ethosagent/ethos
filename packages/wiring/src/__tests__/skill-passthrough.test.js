import { describe, expect, it } from 'vitest';
import { applySkillPassthrough, deriveSkillPassthrough } from '../skill-passthrough';

function makeSkill(overrides = {}) {
  return {
    qualifiedName: 'ethos/test-skill',
    name: 'Test Skill',
    source: 'ethos',
    filePath: '/skills/test.md',
    body: '',
    rawFrontmatter: {},
    dialect: 'agentskills',
    mtimeMs: 1_000_000,
    ...overrides,
  };
}
function makePersonality(overrides = {}) {
  return { id: 'researcher', name: 'Researcher', ...overrides };
}
describe('deriveSkillPassthrough — item 6: only admitted skills contribute env passthrough', () => {
  it('admitted skill contributes its declared mcp_env_passthrough vars', () => {
    const skills = new Map([
      [
        'ethos/github-skill',
        makeSkill({
          qualifiedName: 'ethos/github-skill',
          required_tools: ['read_file'],
          permissions: { mcp_env_passthrough: ['GITHUB_TOKEN'] },
        }),
      ],
    ]);
    const personality = makePersonality({ toolset: ['read_file'] });
    const result = deriveSkillPassthrough(skills, personality, new Set(['read_file']));
    expect(result.has('GITHUB_TOKEN')).toBe(true);
  });
  it('skill rejected by capability filter does not leak its mcp_env_passthrough vars', () => {
    // Skill requires 'run_shell' but personality only has 'read_file'
    const skills = new Map([
      [
        'ethos/shell-skill',
        makeSkill({
          qualifiedName: 'ethos/shell-skill',
          required_tools: ['run_shell'],
          permissions: { mcp_env_passthrough: ['SECRET_KEY'] },
        }),
      ],
    ]);
    const personality = makePersonality({ toolset: ['read_file'] });
    const result = deriveSkillPassthrough(skills, personality, new Set(['read_file']));
    expect(result.has('SECRET_KEY')).toBe(false);
    expect(result.size).toBe(0);
  });
  it('skill rejected by allowed_skill_permissions policy does not leak its passthrough vars', () => {
    // Personality has a safety policy that blocks mcp_env_passthrough entirely
    const skills = new Map([
      [
        'ethos/blocked-skill',
        makeSkill({
          qualifiedName: 'ethos/blocked-skill',
          permissions: { mcp_env_passthrough: ['ADMIN_TOKEN'] },
        }),
      ],
    ]);
    const personality = makePersonality({
      safety: { allowed_skill_permissions: {} }, // empty policy = blocks all passthrough
    });
    const result = deriveSkillPassthrough(skills, personality, new Set());
    expect(result.has('ADMIN_TOKEN')).toBe(false);
    expect(result.size).toBe(0);
  });
  it('only admitted skills contribute when pool contains a mix of admitted and rejected', () => {
    const skills = new Map([
      [
        'ethos/safe-skill',
        makeSkill({
          qualifiedName: 'ethos/safe-skill',
          required_tools: ['read_file'],
          permissions: { mcp_env_passthrough: ['SAFE_TOKEN'] },
        }),
      ],
      [
        'ethos/risky-skill',
        makeSkill({
          qualifiedName: 'ethos/risky-skill',
          required_tools: ['run_shell'],
          permissions: { mcp_env_passthrough: ['DANGER_TOKEN'] },
        }),
      ],
    ]);
    const personality = makePersonality({ toolset: ['read_file'] });
    const result = deriveSkillPassthrough(skills, personality, new Set(['read_file']));
    expect(result.has('SAFE_TOKEN')).toBe(true);
    expect(result.has('DANGER_TOKEN')).toBe(false);
  });
});
describe('applySkillPassthrough — item 7: passthrough scoped to attached servers', () => {
  it('applies passthrough only to servers in the personality mcp_servers list', () => {
    const servers = [
      { name: 'github-server', command: 'npx' },
      { name: 'other-server', command: 'npx' },
    ];
    const passthrough = new Set(['GITHUB_TOKEN']);
    const attached = new Set(['github-server']);
    const result = applySkillPassthrough(servers, passthrough, attached);
    const gh = result.find((s) => s.name === 'github-server');
    const other = result.find((s) => s.name === 'other-server');
    expect(gh?.mcpEnvPassthrough).toContain('GITHUB_TOKEN');
    expect(other?.mcpEnvPassthrough).toBeUndefined();
  });
  it('does not apply passthrough when no mcp_servers attachment list is set', () => {
    // Empty attachedServers means the personality has no attached servers (wiring.ts
    // warns "0 servers attached"). No server should receive skill-requested credentials.
    const servers = [
      { name: 'server-a', command: 'npx' },
      { name: 'server-b', command: 'npx' },
    ];
    const passthrough = new Set(['GITHUB_TOKEN']);
    const result = applySkillPassthrough(servers, passthrough, new Set());
    expect(result.find((s) => s.name === 'server-a')?.mcpEnvPassthrough).toBeUndefined();
    expect(result.find((s) => s.name === 'server-b')?.mcpEnvPassthrough).toBeUndefined();
  });
  it('returns config unchanged when passthrough is empty', () => {
    const servers = [{ name: 'my-server', command: 'npx', mcpEnvPassthrough: ['EXISTING'] }];
    const result = applySkillPassthrough(servers, new Set(), new Set(['my-server']));
    expect(result).toBe(servers); // same reference — no copy
  });
  it('preserves existing mcpEnvPassthrough when merging', () => {
    const servers = [{ name: 'my-server', command: 'npx', mcpEnvPassthrough: ['EXISTING_VAR'] }];
    const passthrough = new Set(['NEW_VAR']);
    const result = applySkillPassthrough(servers, passthrough, new Set(['my-server']));
    expect(result[0]?.mcpEnvPassthrough).toContain('EXISTING_VAR');
    expect(result[0]?.mcpEnvPassthrough).toContain('NEW_VAR');
  });
});
