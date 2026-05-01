import { describe, expect, it } from 'vitest';
import type { ResolveModelInput } from '../model-resolver';
import { resolveModelTarget } from '../model-resolver';

const BASE: ResolveModelInput = {
  isTeam: false,
  isCoordinator: false,
  personalityId: 'researcher',
  globalModel: 'claude-opus-4-7',
  globalModelRouting: undefined,
  teamManifest: undefined,
};

describe('resolveModelTarget — non-team', () => {
  it('falls back to global model when no routing', () => {
    const result = resolveModelTarget(BASE);
    expect(result).toEqual({ model: 'claude-opus-4-7', source: 'global' });
  });

  it('uses globalModelRouting when personality matches', () => {
    const result = resolveModelTarget({
      ...BASE,
      globalModelRouting: { researcher: 'claude-haiku-4-5' },
    });
    expect(result).toEqual({ model: 'claude-haiku-4-5', source: 'personality' });
  });

  it('falls through to global when personality not in routing map', () => {
    const result = resolveModelTarget({
      ...BASE,
      personalityId: 'engineer',
      globalModelRouting: { researcher: 'claude-haiku-4-5' },
    });
    expect(result).toEqual({ model: 'claude-opus-4-7', source: 'global' });
  });
});

describe('resolveModelTarget — team coordinator', () => {
  it('uses coordinator_model from manifest when set', () => {
    const result = resolveModelTarget({
      ...BASE,
      isTeam: true,
      isCoordinator: true,
      teamManifest: {
        name: 'alpha',
        description: '',
        domain_capabilities: [],
        members: [],
        coordinator_model: 'claude-sonnet-4-6',
      },
    });
    expect(result).toEqual({ model: 'claude-sonnet-4-6', source: 'team-coordinator' });
  });

  it('falls back to global model when coordinator_model is absent', () => {
    const result = resolveModelTarget({
      ...BASE,
      isTeam: true,
      isCoordinator: true,
      teamManifest: {
        name: 'alpha',
        description: '',
        domain_capabilities: [],
        members: [],
      },
    });
    expect(result).toEqual({ model: 'claude-opus-4-7', source: 'global' });
  });

  it('coordinator does NOT use globalModelRouting (team-coordinator path bypasses it)', () => {
    const result = resolveModelTarget({
      ...BASE,
      isTeam: true,
      isCoordinator: true,
      personalityId: 'researcher',
      globalModelRouting: { researcher: 'claude-haiku-4-5' },
      teamManifest: {
        name: 'alpha',
        description: '',
        domain_capabilities: [],
        members: [],
      },
    });
    // coordinator_model absent, globalModelRouting should NOT apply → 'global'
    expect(result).toEqual({ model: 'claude-opus-4-7', source: 'global' });
  });
});

describe('resolveModelTarget — team member', () => {
  it('uses personality_models from manifest when personality key matches', () => {
    const result = resolveModelTarget({
      ...BASE,
      isTeam: true,
      isCoordinator: false,
      personalityId: 'engineer',
      teamManifest: {
        name: 'alpha',
        description: '',
        domain_capabilities: [],
        members: [{ personality: 'engineer' }],
        personality_models: { engineer: 'claude-haiku-4-5' },
      },
    });
    expect(result).toEqual({ model: 'claude-haiku-4-5', source: 'team-personality' });
  });

  it('falls through to globalModelRouting when personality_models key absent', () => {
    const result = resolveModelTarget({
      ...BASE,
      isTeam: true,
      isCoordinator: false,
      personalityId: 'engineer',
      globalModelRouting: { engineer: 'claude-sonnet-4-6' },
      teamManifest: {
        name: 'alpha',
        description: '',
        domain_capabilities: [],
        members: [{ personality: 'engineer' }],
        personality_models: { reviewer: 'claude-haiku-4-5' },
      },
    });
    expect(result).toEqual({ model: 'claude-sonnet-4-6', source: 'personality' });
  });

  it('falls through to global model as last resort', () => {
    const result = resolveModelTarget({
      ...BASE,
      isTeam: true,
      isCoordinator: false,
      personalityId: 'engineer',
      teamManifest: {
        name: 'alpha',
        description: '',
        domain_capabilities: [],
        members: [{ personality: 'engineer' }],
      },
    });
    expect(result).toEqual({ model: 'claude-opus-4-7', source: 'global' });
  });

  it('team member personality_models beats globalModelRouting', () => {
    const result = resolveModelTarget({
      ...BASE,
      isTeam: true,
      isCoordinator: false,
      personalityId: 'reviewer',
      globalModelRouting: { reviewer: 'claude-sonnet-4-6' },
      teamManifest: {
        name: 'alpha',
        description: '',
        domain_capabilities: [],
        members: [{ personality: 'reviewer' }],
        personality_models: { reviewer: 'claude-haiku-4-5' },
      },
    });
    // team override beats global personality routing
    expect(result).toEqual({ model: 'claude-haiku-4-5', source: 'team-personality' });
  });
});
