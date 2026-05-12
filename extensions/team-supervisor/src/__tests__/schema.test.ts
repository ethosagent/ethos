import { EthosError } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { parseTeamManifest, validateForStart } from '../schema';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_MANIFEST = `
name: analytics
description: Analytics workflow team
domain_capabilities:
  - analytics
  - data-engineering
dispatch_mode: coordinator
coordinator: coordinator
members:
  - personality: coordinator
    role: coordinator
    port: 3000
  - personality: data-engineer
    port: 3001
    capabilities: [dbt, sql]
    auto_restart: true
  - personality: researcher
    port: 3002
  - personality: reviewer
    port: 3003
`;

const VALID_MINIMAL = `
name: solo
description: Single-member team for testing
domain_capabilities:
  - testing
members:
  - personality: default
`;

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('parseTeamManifest', () => {
  it('returns a valid manifest for a complete spec', () => {
    const result = parseTeamManifest(VALID_MANIFEST);
    expect(result.name).toBe('analytics');
    expect(result.description).toBe('Analytics workflow team');
    expect(result.domain_capabilities).toEqual(['analytics', 'data-engineering']);
    expect(result.dispatch_mode).toBe('coordinator');
    expect(result.coordinator).toBe('coordinator');
    expect(result.members).toHaveLength(4);
    expect(result.members[1]).toEqual({
      personality: 'data-engineer',
      port: 3001,
      capabilities: ['dbt', 'sql'],
      auto_restart: true,
    });
  });

  it('parses a minimal manifest (no dispatch_mode, no coordinator, no optional fields)', () => {
    const result = parseTeamManifest(VALID_MINIMAL);
    expect(result.name).toBe('solo');
    expect(result.members).toHaveLength(1);
    expect(result.dispatch_mode).toBeUndefined();
    expect(result.coordinator).toBeUndefined();
    expect(result.mesh).toBeUndefined();
  });

  it('honours per-member capabilities override', () => {
    const result = parseTeamManifest(VALID_MANIFEST);
    expect(result.members[1]?.capabilities).toEqual(['dbt', 'sql']);
    expect(result.members[2]?.capabilities).toBeUndefined();
  });

  it('accepts broadcast dispatch mode', () => {
    const yaml = `
name: broadcast-team
description: Sends to all members
domain_capabilities: [general]
dispatch_mode: broadcast
members:
  - personality: alpha
  - personality: beta
`;
    const result = parseTeamManifest(yaml);
    expect(result.dispatch_mode).toBe('broadcast');
  });

  it('accepts self-routing dispatch mode without coordinator', () => {
    const yaml = `
name: routing-team
description: Self-routes work
domain_capabilities: [routing]
dispatch_mode: self-routing
members:
  - personality: worker
`;
    const result = parseTeamManifest(yaml);
    expect(result.dispatch_mode).toBe('self-routing');
  });

  it('accepts optional mesh field', () => {
    const yaml = `
name: shared
description: Shared mesh team
domain_capabilities: [shared]
mesh: engineering
members:
  - personality: backend
`;
    const result = parseTeamManifest(yaml);
    expect(result.mesh).toBe('engineering');
  });
});

// ---------------------------------------------------------------------------
// coordinator / dispatch_mode cross-field validation
// ---------------------------------------------------------------------------

describe('parseTeamManifest — coordinator constraint', () => {
  it('throws TEAM_MANIFEST_INVALID when dispatch_mode is coordinator but coordinator field is absent', () => {
    const yaml = `
name: bad-team
description: Missing coordinator field
domain_capabilities: [analytics]
dispatch_mode: coordinator
members:
  - personality: worker
`;
    expect(() => parseTeamManifest(yaml)).toThrow(EthosError);
    try {
      parseTeamManifest(yaml);
    } catch (err) {
      expect(err).toBeInstanceOf(EthosError);
      const e = err as EthosError;
      expect(e.code).toBe('TEAM_MANIFEST_INVALID');
      expect(e.cause).toContain('coordinator');
    }
  });

  it('warns (does not throw) when dispatch_mode is self-routing but coordinator is set', () => {
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: vi.fn() };
    logger.child.mockReturnValue(logger);
    const yaml = `
name: warn-team
description: coordinator set but mode is self-routing
domain_capabilities: [general]
dispatch_mode: self-routing
coordinator: leader
members:
  - personality: worker
`;
    const result = parseTeamManifest(yaml, { logger });
    expect(result.name).toBe('warn-team');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('coordinator'), expect.any(Object));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('self-routing'), expect.any(Object));
  });

  it('implicit coordinator mode (no dispatch_mode, coordinator set) is valid', () => {
    const yaml = `
name: implicit-coord
description: Implicit coordinator mode
domain_capabilities: [general]
coordinator: leader
members:
  - personality: leader
    role: coordinator
  - personality: worker
`;
    const result = parseTeamManifest(yaml);
    expect(result.coordinator).toBe('leader');
    expect(result.dispatch_mode).toBeUndefined();
  });

  it('rejects coordinator mode with no role=coordinator member (fail-closed)', () => {
    const yaml = `
name: missing-role
description: Coordinator missing role
domain_capabilities: [general]
coordinator: leader
members:
  - personality: leader
  - personality: worker
`;
    expect(() => parseTeamManifest(yaml)).toThrow(EthosError);
    try {
      parseTeamManifest(yaml);
    } catch (err) {
      const e = err as EthosError;
      expect(e.code).toBe('TEAM_MANIFEST_INVALID');
      expect(e.cause).toMatch(/exactly one member with role=coordinator/);
    }
  });

  it('rejects coordinator mode when role=coordinator does not match top-level coordinator field', () => {
    const yaml = `
name: mismatch
description: role mismatch
domain_capabilities: [general]
coordinator: leader
members:
  - personality: worker
    role: coordinator
  - personality: leader
`;
    expect(() => parseTeamManifest(yaml)).toThrow(EthosError);
    try {
      parseTeamManifest(yaml);
    } catch (err) {
      const e = err as EthosError;
      expect(e.code).toBe('TEAM_MANIFEST_INVALID');
      expect(e.cause).toMatch(/does not match/);
    }
  });
});

// ---------------------------------------------------------------------------
// Validation errors — required fields
// ---------------------------------------------------------------------------

describe('parseTeamManifest — field validation errors', () => {
  it('throws TEAM_MANIFEST_INVALID when name is missing', () => {
    const yaml = `
description: No name field
domain_capabilities: [x]
members:
  - personality: worker
`;
    expect(() => parseTeamManifest(yaml)).toThrow(EthosError);
    try {
      parseTeamManifest(yaml);
    } catch (err) {
      const e = err as EthosError;
      expect(e.code).toBe('TEAM_MANIFEST_INVALID');
      expect(e.cause).toContain('name');
    }
  });

  it('throws TEAM_MANIFEST_INVALID when description is missing', () => {
    const yaml = `
name: nodesc
domain_capabilities: [x]
members:
  - personality: worker
`;
    expect(() => parseTeamManifest(yaml)).toThrow(EthosError);
    try {
      parseTeamManifest(yaml);
    } catch (err) {
      const e = err as EthosError;
      expect(e.code).toBe('TEAM_MANIFEST_INVALID');
      expect(e.cause).toContain('description');
    }
  });

  it('throws TEAM_MANIFEST_INVALID when domain_capabilities is missing', () => {
    const yaml = `
name: nocaps
description: Missing domain_capabilities
members:
  - personality: worker
`;
    expect(() => parseTeamManifest(yaml)).toThrow(EthosError);
    try {
      parseTeamManifest(yaml);
    } catch (err) {
      const e = err as EthosError;
      expect(e.code).toBe('TEAM_MANIFEST_INVALID');
      expect(e.cause).toContain('domain_capabilities');
    }
  });

  it('parses (does not throw) when members list is empty — draft state', () => {
    const yaml = `
name: empty-members
description: Draft team
domain_capabilities: [x]
members: []
`;
    const result = parseTeamManifest(yaml);
    expect(result.members).toHaveLength(0);
  });

  it('throws TEAM_MANIFEST_INVALID when members is absent', () => {
    const yaml = `
name: no-members
description: Members key absent
domain_capabilities: [x]
`;
    expect(() => parseTeamManifest(yaml)).toThrow(EthosError);
    try {
      parseTeamManifest(yaml);
    } catch (err) {
      const e = err as EthosError;
      expect(e.code).toBe('TEAM_MANIFEST_INVALID');
      expect(e.cause).toContain('members');
    }
  });

  it('throws TEAM_MANIFEST_INVALID for an unknown dispatch_mode value', () => {
    const yaml = `
name: bad-mode
description: Unknown dispatch mode
domain_capabilities: [x]
dispatch_mode: roundrobin
members:
  - personality: worker
`;
    expect(() => parseTeamManifest(yaml)).toThrow(EthosError);
    try {
      parseTeamManifest(yaml);
    } catch (err) {
      const e = err as EthosError;
      expect(e.code).toBe('TEAM_MANIFEST_INVALID');
      expect(e.cause).toContain('dispatch_mode');
    }
  });

  it('throws TEAM_MANIFEST_INVALID when a member is missing personality', () => {
    const yaml = `
name: bad-member
description: Member without personality
domain_capabilities: [x]
members:
  - port: 3001
`;
    expect(() => parseTeamManifest(yaml)).toThrow(EthosError);
    try {
      parseTeamManifest(yaml);
    } catch (err) {
      const e = err as EthosError;
      expect(e.code).toBe('TEAM_MANIFEST_INVALID');
      // Path should reference the members array
      expect(e.cause).toMatch(/member|personality/i);
    }
  });
});

// ---------------------------------------------------------------------------
// validateForStart
// ---------------------------------------------------------------------------

describe('validateForStart', () => {
  it('passes when manifest has at least one member', () => {
    const manifest = parseTeamManifest(VALID_MINIMAL);
    expect(() => validateForStart(manifest)).not.toThrow();
  });

  it('throws TEAM_MANIFEST_INVALID when members list is empty', () => {
    const yaml = `
name: empty-members
description: Draft team
domain_capabilities: [x]
members: []
`;
    const manifest = parseTeamManifest(yaml);
    expect(() => validateForStart(manifest)).toThrow(EthosError);
    try {
      validateForStart(manifest);
    } catch (err) {
      const e = err as EthosError;
      expect(e.code).toBe('TEAM_MANIFEST_INVALID');
      expect(e.cause).toContain('no members');
      expect(e.action).toContain('ethos team empty-members add');
    }
  });
});

// ---------------------------------------------------------------------------
// Model routing fields — coordinator_model + personality_models
// ---------------------------------------------------------------------------

describe('parseTeamManifest — model routing fields', () => {
  it('parses coordinator_model when present', () => {
    const yaml = `
name: alpha
description: Test
domain_capabilities: [x]
coordinator: researcher
coordinator_model: claude-haiku-4-5
members:
  - personality: researcher
    role: coordinator
  - personality: engineer
`;
    const result = parseTeamManifest(yaml);
    expect(result.coordinator_model).toBe('claude-haiku-4-5');
  });

  it('parses personality_models map when present', () => {
    const yaml = `
name: alpha
description: Test
domain_capabilities: [x]
members:
  - personality: researcher
  - personality: engineer
personality_models:
  researcher: claude-sonnet-4-6
  engineer: claude-haiku-4-5
`;
    const result = parseTeamManifest(yaml);
    expect(result.personality_models).toEqual({
      researcher: 'claude-sonnet-4-6',
      engineer: 'claude-haiku-4-5',
    });
  });

  it('leaves coordinator_model and personality_models undefined when absent', () => {
    const result = parseTeamManifest(`
name: minimal
description: x
domain_capabilities: [x]
members:
  - personality: worker
`);
    expect(result.coordinator_model).toBeUndefined();
    expect(result.personality_models).toBeUndefined();
  });
});

describe('validateForStart — model routing warnings', () => {
  it('warns when personality_models contains a key not matching any member', () => {
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: vi.fn() };
    logger.child.mockReturnValue(logger);
    const yaml = `
name: alpha
description: Test
domain_capabilities: [x]
members:
  - personality: researcher
personality_models:
  engineer: claude-haiku-4-5
`;
    const manifest = parseTeamManifest(yaml);
    validateForStart(manifest, { logger });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('engineer'), expect.any(Object));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('personality_models'),
      expect.any(Object),
    );
  });

  it('does not warn when all personality_models keys match members', () => {
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: vi.fn() };
    logger.child.mockReturnValue(logger);
    const yaml = `
name: alpha
description: Test
domain_capabilities: [x]
members:
  - personality: researcher
  - personality: engineer
personality_models:
  researcher: claude-sonnet-4-6
  engineer: claude-haiku-4-5
`;
    const manifest = parseTeamManifest(yaml);
    validateForStart(manifest, { logger });
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// supervisor launch args — model override passthrough
// ---------------------------------------------------------------------------

describe('buildMemberLaunchArgs', () => {
  // Use dynamic import to avoid pulling in supervisor side-effects
  it('includes --model when modelOverride is provided', async () => {
    const { buildMemberLaunchArgs } = await import('../supervisor');
    const args = buildMemberLaunchArgs(
      '/usr/bin/ethos',
      3001,
      'engineer',
      'alpha',
      'claude-haiku-4-5',
    );
    expect(args).toContain('--model');
    expect(args).toContain('claude-haiku-4-5');
  });

  it('omits --model when no override provided', async () => {
    const { buildMemberLaunchArgs } = await import('../supervisor');
    const args = buildMemberLaunchArgs('/usr/bin/ethos', 3001, 'engineer', 'alpha');
    expect(args).not.toContain('--model');
  });

  it('passes --team and --role when both are provided (Plan B member spawn)', async () => {
    const { buildMemberLaunchArgs } = await import('../supervisor');
    const args = buildMemberLaunchArgs(
      '/usr/bin/ethos',
      3001,
      'engineer',
      'alpha',
      undefined,
      'analytics',
      'member',
    );
    expect(args).toContain('--team');
    expect(args[args.indexOf('--team') + 1]).toBe('analytics');
    expect(args).toContain('--role');
    expect(args[args.indexOf('--role') + 1]).toBe('member');
  });

  it('omits --team and --role when neither is provided (solo serve)', async () => {
    const { buildMemberLaunchArgs } = await import('../supervisor');
    const args = buildMemberLaunchArgs('/usr/bin/ethos', 3001, 'engineer', 'alpha');
    expect(args).not.toContain('--team');
    expect(args).not.toContain('--role');
  });
});

// ---------------------------------------------------------------------------
// YAML parse errors
// ---------------------------------------------------------------------------

describe('parseTeamManifest — YAML syntax errors', () => {
  it('throws TEAM_MANIFEST_INVALID on invalid YAML', () => {
    const badYaml = `
name: broken
description: [unclosed bracket
`;
    expect(() => parseTeamManifest(badYaml)).toThrow(EthosError);
    try {
      parseTeamManifest(badYaml);
    } catch (err) {
      const e = err as EthosError;
      expect(e.code).toBe('TEAM_MANIFEST_INVALID');
      expect(e.cause).toContain('YAML parse error');
    }
  });

  it('throws TEAM_MANIFEST_INVALID when YAML parses to a non-object (e.g. scalar)', () => {
    expect(() => parseTeamManifest('just a string')).toThrow(EthosError);
    try {
      parseTeamManifest('just a string');
    } catch (err) {
      const e = err as EthosError;
      expect(e.code).toBe('TEAM_MANIFEST_INVALID');
    }
  });
});
