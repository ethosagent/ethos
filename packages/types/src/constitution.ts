// Phase 2a (Lane D1) — the operator-authoritative constitution contract.
//
// A `Constitution` is the host operator's ceiling over every personality:
// budget caps, forbidden hosts/tools, observability floor, filesystem mount
// bounds, and execution-posture requirements. It is loaded from
// `~/.ethos/constitution.yaml` and enforced at wiring time. A malformed
// constitution drops the process into SAFE MODE (built-ins only, read-only
// toolsets); a hard violation throws `ConstitutionViolationError` and aborts
// the run.
//
// This interface is SCHEMA-FROZEN. The top-level field count is mirrored in
// `.constitution-field-count` at the repo root and enforced by the drift gate
// at `packages/types/src/__tests__/constitution-field-count.test.ts`. Adding a
// top-level field to `Constitution` without bumping `.constitution-field-count`
// in the same commit fails CI. Treat a field addition as a schema change, not a
// convenience tweak.

export interface Constitution {
  budget?: {
    maxUsdPerSession?: number;
  };
  forbidden?: {
    hosts?: string[];
    tools?: string[];
  };
  observability?: {
    minimum?: 'none' | 'redacted' | 'full';
  };
  filesystem?: {
    allowedMountRoots?: string[];
    deniedPathPrefixes?: string[];
  };
  execution?: {
    requireSandbox?: boolean;
    forbidLocal?: boolean;
  };
}

export const PERMISSIVE_DEFAULT_CONSTITUTION: Constitution = {};

export class ConstitutionViolationError extends Error {
  readonly code = 'CONSTITUTION_VIOLATION' as const;
  constructor(
    public readonly personalityId: string,
    public readonly reason: string,
  ) {
    super(`Personality "${personalityId}" violates the constitution: ${reason}`);
    this.name = 'ConstitutionViolationError';
  }
}

export interface ConstitutionClamp {
  personalityId: string;
  field: 'budgetCapUsd';
  declared: number;
  clamped: number;
}

export interface ConstitutionEnforcement {
  clamps: ConstitutionClamp[];
}

export type ConstitutionLoadResult =
  | { status: 'loaded'; constitution: Constitution }
  | { status: 'missing'; constitution: Constitution }
  | { status: 'malformed'; error: string };
