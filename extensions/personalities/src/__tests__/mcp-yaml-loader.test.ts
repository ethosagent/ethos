import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilePersonalityRegistry, parseMcpYaml, renderMcpYaml } from '../index';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-mcp-yaml-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('parseMcpYaml', () => {
  it('parses valid servers map with tools list', () => {
    const src = [
      'servers:',
      '  linear:',
      '    tools:',
      '      - list_issues',
      '      - get_issue',
      '  slack:',
      '    tools:',
      '      - search_public',
    ].join('\n');

    const { policy, warnings } = parseMcpYaml(src);
    expect(policy.servers).toBeDefined();
    expect(policy.servers?.linear?.tools).toEqual(['list_issues', 'get_issue']);
    expect(policy.servers?.slack?.tools).toEqual(['search_public']);
    expect(warnings).toEqual([]);
  });

  it('extracts tools list per server', () => {
    const src = [
      'servers:',
      '  github:',
      '    tools:',
      '      - list_repos',
      '      - get_pull_request',
      '      - create_issue',
    ].join('\n');

    const { policy } = parseMcpYaml(src);
    const tools = policy.servers?.github?.tools;
    expect(tools).toEqual(['list_repos', 'get_pull_request', 'create_issue']);
  });

  it('parses reject_args', () => {
    const src = [
      'servers:',
      '  linear:',
      '    reject_args:',
      '      save_issue:',
      '        status:',
      '          - Done',
      '          - Cancelled',
    ].join('\n');

    const { policy } = parseMcpYaml(src);
    const rejectArgs = policy.servers?.linear?.reject_args;
    expect(rejectArgs).toBeDefined();
    expect(rejectArgs?.save_issue?.status).toEqual(['Done', 'Cancelled']);
  });

  it('parses both tools and reject_args on the same server', () => {
    const src = [
      'servers:',
      '  linear:',
      '    tools:',
      '      - list_issues',
      '      - save_issue',
      '    reject_args:',
      '      save_issue:',
      '        status:',
      '          - Done',
    ].join('\n');

    const { policy } = parseMcpYaml(src);
    expect(policy.servers?.linear?.tools).toEqual(['list_issues', 'save_issue']);
    expect(policy.servers?.linear?.reject_args?.save_issue?.status).toEqual(['Done']);
  });

  it('returns empty policy for empty input', () => {
    const { policy, warnings } = parseMcpYaml('');
    expect(policy.servers).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('returns empty policy for input without servers key', () => {
    const { policy, warnings } = parseMcpYaml('# just a comment\n');
    expect(policy.servers).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('handles comments in mcp.yaml', () => {
    const src = [
      '# MCP policy for this personality',
      'servers:',
      '  linear:',
      '    # Only allow read-only tools',
      '    tools:',
      '      - list_issues',
      '      # - save_issue  # disabled',
      '      - get_issue',
    ].join('\n');

    const { policy, warnings } = parseMcpYaml(src);
    expect(policy.servers?.linear?.tools).toEqual(['list_issues', 'get_issue']);
    expect(warnings).toEqual([]);
  });

  it('warns on tab-indented lines', () => {
    const src = ['servers:', '\tlinear:', '\t\ttools:', '\t\t\t- list_issues'].join('\n');

    const { warnings } = parseMcpYaml(src);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes('tab character'))).toBe(true);
  });

  it('warns on unknown key under a server', () => {
    const src = [
      'servers:',
      '  linear:',
      '    tools:',
      '      - list_issues',
      '    scopes:',
      '      - read',
    ].join('\n');

    const { policy, warnings } = parseMcpYaml(src);
    // tools: still parsed correctly
    expect(policy.servers?.linear?.tools).toEqual(['list_issues']);
    // scopes: triggers a warning
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes('unknown key "scopes"'))).toBe(true);
  });

  it('warns on unrecognized line under servers at indent 2', () => {
    const src = ['servers:', '  - linear', '  slack:', '    tools:', '      - search_public'].join(
      '\n',
    );

    const { policy, warnings } = parseMcpYaml(src);
    // slack still parsed
    expect(policy.servers?.slack?.tools).toEqual(['search_public']);
    // "  - linear" triggers a warning
    expect(warnings.some((w) => w.includes('unrecognized line under servers:'))).toBe(true);
  });

  it('valid YAML produces no warnings', () => {
    const src = [
      'servers:',
      '  linear:',
      '    tools:',
      '      - list_issues',
      '    reject_args:',
      '      save_issue:',
      '        status:',
      '          - Done',
    ].join('\n');

    const { warnings } = parseMcpYaml(src);
    expect(warnings).toEqual([]);
  });

  it('parses enabled: false', () => {
    const src = ['servers:', '  myserver:', '    enabled: false'].join('\n');

    const { policy, warnings } = parseMcpYaml(src);
    expect(policy.servers?.myserver?.enabled).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('parses enabled: true', () => {
    const src = ['servers:', '  myserver:', '    enabled: true'].join('\n');

    const { policy, warnings } = parseMcpYaml(src);
    expect(policy.servers?.myserver?.enabled).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('enabled: false does not trigger unknown-key warning', () => {
    const src = ['servers:', '  linear:', '    enabled: false'].join('\n');

    const { warnings } = parseMcpYaml(src);
    expect(warnings).toEqual([]);
  });
});

describe('renderMcpYaml', () => {
  it('returns empty string for a policy with no servers', () => {
    expect(renderMcpYaml({})).toBe('');
    expect(renderMcpYaml({ servers: {} })).toBe('');
  });

  it('round-trips a tools-only policy', () => {
    const src = [
      'servers:',
      '  linear:',
      '    tools:',
      '      - list_issues',
      '      - get_issue',
      '  slack:',
      '    tools:',
      '      - search_public',
      '',
    ].join('\n');
    const { policy } = parseMcpYaml(src);
    expect(renderMcpYaml(policy)).toBe(src);
  });

  it('round-trips reject_args alongside tools', () => {
    const src = [
      'servers:',
      '  linear:',
      '    tools:',
      '      - list_issues',
      '      - save_issue',
      '    reject_args:',
      '      save_issue:',
      '        status:',
      '          - Done',
      '          - Cancelled',
      '',
    ].join('\n');
    const { policy } = parseMcpYaml(src);
    expect(renderMcpYaml(policy)).toBe(src);
  });

  it('parse(render(policy)) is identity for a reject_args-only server', () => {
    const policy = {
      servers: {
        linear: {
          reject_args: { save_issue: { status: ['Done'] } },
        },
      },
    };
    const reparsed = parseMcpYaml(renderMcpYaml(policy));
    expect(reparsed.policy).toEqual(policy);
    expect(reparsed.warnings).toEqual([]);
  });

  it('emits an explicit empty tools list', () => {
    const rendered = renderMcpYaml({ servers: { linear: { tools: [] } } });
    expect(rendered).toBe(['servers:', '  linear:', '    tools:', ''].join('\n'));
    const { policy } = parseMcpYaml(rendered);
    expect(policy.servers?.linear?.tools).toEqual([]);
  });

  it('round-trips enabled: false', () => {
    const src = ['servers:', '  myserver:', '    enabled: false', ''].join('\n');
    const { policy } = parseMcpYaml(src);
    const reparsed = parseMcpYaml(renderMcpYaml(policy));
    expect(reparsed.policy).toEqual(policy);
    expect(reparsed.warnings).toEqual([]);
  });

  it('emits enabled: false when the field is set', () => {
    const rendered = renderMcpYaml({ servers: { linear: { enabled: false } } });
    expect(rendered).toContain('    enabled: false');
  });
});

describe('FilePersonalityRegistry — writeMcpToolSubsets', () => {
  it('writes a tool subset for an attached server', async () => {
    const personalityDir = join(testDir, 'personalities', 'agent');
    await mkdir(personalityDir, { recursive: true });
    await writeFile(join(personalityDir, 'config.yaml'), 'name: Agent\nmcp_servers: linear\n');
    await writeFile(join(personalityDir, 'SOUL.md'), '# Agent');

    const reg = new FilePersonalityRegistry(undefined, testDir);
    await reg.loadFromDirectory(join(testDir, 'personalities'));

    await reg.writeMcpToolSubsets('agent', { linear: ['list_issues', 'get_issue'] });

    const policy = reg.getMcpPolicy('agent');
    expect(policy?.servers?.linear?.tools).toEqual(['list_issues', 'get_issue']);
  });

  it('preserves reject_args when narrowing a tool subset', async () => {
    const personalityDir = join(testDir, 'personalities', 'with-reject');
    await mkdir(personalityDir, { recursive: true });
    await writeFile(join(personalityDir, 'config.yaml'), 'name: With Reject\n');
    await writeFile(join(personalityDir, 'SOUL.md'), '# With Reject');
    await writeFile(
      join(personalityDir, 'mcp.yaml'),
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

    const reg = new FilePersonalityRegistry(undefined, testDir);
    await reg.loadFromDirectory(join(testDir, 'personalities'));

    await reg.writeMcpToolSubsets('with-reject', { linear: ['list_issues'] });

    const policy = reg.getMcpPolicy('with-reject');
    expect(policy?.servers?.linear?.tools).toEqual(['list_issues']);
    // reject_args must survive the round-trip untouched.
    expect(policy?.servers?.linear?.reject_args?.save_issue?.status).toEqual(['Done']);
  });

  it('clears a tools key with null, keeping the server entry when reject_args remains', async () => {
    const personalityDir = join(testDir, 'personalities', 'clear-tools');
    await mkdir(personalityDir, { recursive: true });
    await writeFile(join(personalityDir, 'config.yaml'), 'name: Clear Tools\n');
    await writeFile(join(personalityDir, 'SOUL.md'), '# Clear Tools');
    await writeFile(
      join(personalityDir, 'mcp.yaml'),
      [
        'servers:',
        '  linear:',
        '    tools:',
        '      - list_issues',
        '    reject_args:',
        '      save_issue:',
        '        status:',
        '          - Done',
      ].join('\n'),
    );

    const reg = new FilePersonalityRegistry(undefined, testDir);
    await reg.loadFromDirectory(join(testDir, 'personalities'));

    await reg.writeMcpToolSubsets('clear-tools', { linear: null });

    const policy = reg.getMcpPolicy('clear-tools');
    expect(policy?.servers?.linear?.tools).toBeUndefined();
    expect(policy?.servers?.linear?.reject_args?.save_issue?.status).toEqual(['Done']);
  });

  it('removes the mcp.yaml file when clearing the only server with no reject_args', async () => {
    const personalityDir = join(testDir, 'personalities', 'all-default');
    await mkdir(personalityDir, { recursive: true });
    await writeFile(join(personalityDir, 'config.yaml'), 'name: All Default\n');
    await writeFile(join(personalityDir, 'SOUL.md'), '# All Default');
    await writeFile(
      join(personalityDir, 'mcp.yaml'),
      ['servers:', '  linear:', '    tools:', '      - list_issues'].join('\n'),
    );

    const reg = new FilePersonalityRegistry(undefined, testDir);
    await reg.loadFromDirectory(join(testDir, 'personalities'));

    await reg.writeMcpToolSubsets('all-default', { linear: null });

    expect(reg.getMcpPolicy('all-default')).toBeUndefined();
  });

  it('leaves untouched servers intact', async () => {
    const personalityDir = join(testDir, 'personalities', 'multi');
    await mkdir(personalityDir, { recursive: true });
    await writeFile(join(personalityDir, 'config.yaml'), 'name: Multi\n');
    await writeFile(join(personalityDir, 'SOUL.md'), '# Multi');
    await writeFile(
      join(personalityDir, 'mcp.yaml'),
      [
        'servers:',
        '  linear:',
        '    tools:',
        '      - list_issues',
        '  slack:',
        '    tools:',
        '      - search_public',
      ].join('\n'),
    );

    const reg = new FilePersonalityRegistry(undefined, testDir);
    await reg.loadFromDirectory(join(testDir, 'personalities'));

    await reg.writeMcpToolSubsets('multi', { linear: ['get_issue'] });

    const policy = reg.getMcpPolicy('multi');
    expect(policy?.servers?.linear?.tools).toEqual(['get_issue']);
    // slack was not in the subsets map — it must be unchanged.
    expect(policy?.servers?.slack?.tools).toEqual(['search_public']);
  });

  it('throws for a built-in personality', async () => {
    const reg = new FilePersonalityRegistry(undefined, testDir);
    await reg.loadBuiltins();
    await expect(reg.writeMcpToolSubsets('researcher', { linear: ['x'] })).rejects.toThrow();
  });

  it('preserves enabled when clearing tools with null', async () => {
    const personalityDir = join(testDir, 'personalities', 'enabled-only');
    await mkdir(personalityDir, { recursive: true });
    await writeFile(join(personalityDir, 'config.yaml'), 'name: Enabled Only\n');
    await writeFile(join(personalityDir, 'SOUL.md'), '# Enabled Only');
    await writeFile(
      join(personalityDir, 'mcp.yaml'),
      ['servers:', '  linear:', '    enabled: false', '    tools:', '      - list_issues'].join(
        '\n',
      ),
    );

    const reg = new FilePersonalityRegistry(undefined, testDir);
    await reg.loadFromDirectory(join(testDir, 'personalities'));

    await reg.writeMcpToolSubsets('enabled-only', { linear: null });

    const policy = reg.getMcpPolicy('enabled-only');
    // tools removed, but enabled: false must survive
    expect(policy?.servers?.linear?.tools).toBeUndefined();
    expect(policy?.servers?.linear?.enabled).toBe(false);
  });
});

describe('FilePersonalityRegistry — mcp.yaml loading', () => {
  it('loads mcp.yaml and exposes McpPolicy via getMcpPolicy', async () => {
    const personalityDir = join(testDir, 'test-agent');
    await mkdir(personalityDir);
    await writeFile(
      join(personalityDir, 'config.yaml'),
      'name: Test Agent\nmcp_servers: linear slack\n',
    );
    await writeFile(join(personalityDir, 'SOUL.md'), '# Test\nI am a test agent.');
    await writeFile(
      join(personalityDir, 'mcp.yaml'),
      ['servers:', '  linear:', '    tools:', '      - list_issues', '      - get_issue'].join(
        '\n',
      ),
    );

    const reg = new FilePersonalityRegistry();
    await reg.loadFromDirectory(testDir);

    const policy = reg.getMcpPolicy('test-agent');
    expect(policy).toBeDefined();
    expect(policy?.servers?.linear?.tools).toEqual(['list_issues', 'get_issue']);
  });

  it('returns undefined McpPolicy when no mcp.yaml exists', async () => {
    const personalityDir = join(testDir, 'no-mcp');
    await mkdir(personalityDir);
    await writeFile(join(personalityDir, 'config.yaml'), 'name: No MCP\n');
    await writeFile(join(personalityDir, 'SOUL.md'), '# No MCP\nI have no MCP policy.');

    const reg = new FilePersonalityRegistry();
    await reg.loadFromDirectory(testDir);

    expect(reg.getMcpPolicy('no-mcp')).toBeUndefined();
  });

  it('exposes McpPolicy via describe()', async () => {
    const personalityDir = join(testDir, 'described');
    await mkdir(personalityDir, { recursive: true });
    await writeFile(join(personalityDir, 'config.yaml'), 'name: Described\n');
    await writeFile(join(personalityDir, 'SOUL.md'), '# Described');
    await writeFile(
      join(personalityDir, 'mcp.yaml'),
      ['servers:', '  slack:', '    tools:', '      - search_public'].join('\n'),
    );

    const reg = new FilePersonalityRegistry(undefined, testDir);
    await reg.loadFromDirectory(testDir);

    const described = reg.describe('described');
    expect(described?.mcpPolicy).toBeDefined();
    expect(described?.mcpPolicy?.servers?.slack?.tools).toEqual(['search_public']);
  });

  it('surfaces mcpWarnings via describe() when mcp.yaml has structural issues', async () => {
    const personalityDir = join(testDir, 'warn-agent');
    await mkdir(personalityDir);
    await writeFile(join(personalityDir, 'config.yaml'), 'name: Warn Agent\n');
    await writeFile(join(personalityDir, 'SOUL.md'), '# Warn');
    await writeFile(
      join(personalityDir, 'mcp.yaml'),
      [
        'servers:',
        '  linear:',
        '    tools:',
        '      - list_issues',
        '    scopes:',
        '      - read',
      ].join('\n'),
    );

    const reg = new FilePersonalityRegistry(undefined, testDir);
    await reg.loadFromDirectory(testDir);

    const described = reg.describe('warn-agent');
    expect(described).toBeDefined();
    expect(described?.mcpWarnings).toBeDefined();
    expect(described?.mcpWarnings?.some((w) => w.includes('unknown key "scopes"'))).toBe(true);
    // Policy is still parsed (partially) — tools: was valid
    expect(described?.mcpPolicy?.servers?.linear?.tools).toEqual(['list_issues']);
  });

  it('does not surface mcpWarnings when mcp.yaml is valid', async () => {
    const personalityDir = join(testDir, 'clean-agent');
    await mkdir(personalityDir);
    await writeFile(join(personalityDir, 'config.yaml'), 'name: Clean Agent\n');
    await writeFile(join(personalityDir, 'SOUL.md'), '# Clean');
    await writeFile(
      join(personalityDir, 'mcp.yaml'),
      ['servers:', '  linear:', '    tools:', '      - list_issues'].join('\n'),
    );

    const reg = new FilePersonalityRegistry(undefined, testDir);
    await reg.loadFromDirectory(testDir);

    const described = reg.describe('clean-agent');
    expect(described).toBeDefined();
    expect(described?.mcpWarnings).toBeUndefined();
  });

  it('fingerprint includes mcp.yaml — editing it invalidates the mtime cache', async () => {
    const personalityDir = join(testDir, 'cached');
    await mkdir(personalityDir);
    await writeFile(join(personalityDir, 'config.yaml'), 'name: Cached\n');
    await writeFile(join(personalityDir, 'SOUL.md'), '# Cached');

    const reg = new FilePersonalityRegistry();
    await reg.loadFromDirectory(testDir);

    // Initially no mcp.yaml
    expect(reg.getMcpPolicy('cached')).toBeUndefined();

    // Add mcp.yaml — need a small delay so mtime changes
    await new Promise((r) => setTimeout(r, 50));
    await writeFile(
      join(personalityDir, 'mcp.yaml'),
      ['servers:', '  linear:', '    tools:', '      - list_issues'].join('\n'),
    );

    // Reload — the fingerprint should change because mcp.yaml is new
    await reg.loadFromDirectory(testDir);
    const policy = reg.getMcpPolicy('cached');
    expect(policy?.servers?.linear?.tools).toEqual(['list_issues']);
  });
});
