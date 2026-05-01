import type { TeamManifest } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Model routing resolver
//
// Single entry point for all run paths (non-team, team coordinator, team member).
// Enforces the precedence rules from plan/phases/model_update.md.
// ---------------------------------------------------------------------------

export type ModelSource = 'team-coordinator' | 'team-personality' | 'personality' | 'global';

export interface ModelTarget {
  model: string;
  source: ModelSource;
}

export interface ResolveModelInput {
  isTeam: boolean;
  isCoordinator: boolean;
  personalityId: string;
  teamManifest?: TeamManifest;
  globalModel: string;
  globalModelRouting?: Record<string, string>;
}

/**
 * Resolve the effective model for a run.
 *
 * Precedence (from plan/phases/model_update.md):
 *
 * Non-team:
 *   1. globalModelRouting[personalityId]  → source: 'personality'
 *   2. globalModel                         → source: 'global'
 *
 * Team coordinator:
 *   1. teamManifest.coordinator_model     → source: 'team-coordinator'
 *   2. globalModel                         → source: 'global'
 *
 * Team member:
 *   1. teamManifest.personality_models[personalityId]  → source: 'team-personality'
 *   2. globalModelRouting[personalityId]               → source: 'personality'
 *   3. globalModel                                      → source: 'global'
 */
export function resolveModelTarget(input: ResolveModelInput): ModelTarget {
  const { isTeam, isCoordinator, personalityId, teamManifest, globalModel, globalModelRouting } =
    input;

  if (isTeam && isCoordinator) {
    const override = teamManifest?.coordinator_model;
    if (override) return { model: override, source: 'team-coordinator' };
    return { model: globalModel, source: 'global' };
  }

  if (isTeam && !isCoordinator) {
    const teamOverride = teamManifest?.personality_models?.[personalityId];
    if (teamOverride) return { model: teamOverride, source: 'team-personality' };
    const personalityOverride = globalModelRouting?.[personalityId];
    if (personalityOverride) return { model: personalityOverride, source: 'personality' };
    return { model: globalModel, source: 'global' };
  }

  // Non-team
  const personalityOverride = globalModelRouting?.[personalityId];
  if (personalityOverride) return { model: personalityOverride, source: 'personality' };
  return { model: globalModel, source: 'global' };
}
