import { describe, expect, it } from 'vitest';
import {
  MODEL_ROLE_NAMES,
  type ModelResolutionSource,
  type ModelRoleName,
} from '../model-registry';
import type { ModelTierName } from '../personality';

describe('model registry role vocabulary', () => {
  // D1 — roles reuse ModelTierName's values. Changing this list means changing
  // the tier vocabulary, which every personality that declares a tier map reads.
  it('has exactly the four role names, in ModelTierName order', () => {
    expect([...MODEL_ROLE_NAMES]).toEqual(['trivial', 'default', 'deep', 'dreaming']);
    expect(MODEL_ROLE_NAMES).toHaveLength(4);
  });

  it('names exactly the members of ModelTierName', () => {
    // Type-level: a missing key or an extra one is a tsc error, so the runtime
    // assertion below cannot pass against a drifted union.
    const everyTier: Record<ModelTierName, true> = {
      trivial: true,
      default: true,
      deep: true,
      dreaming: true,
    };
    expect(Object.keys(everyTier).sort()).toEqual([...MODEL_ROLE_NAMES].sort());

    // And ModelRoleName is that same union, not a parallel copy of it.
    const asTier: ModelTierName = 'deep' satisfies ModelRoleName;
    expect(MODEL_ROLE_NAMES).toContain(asTier);
  });
});

describe('ModelResolutionSource', () => {
  // D7 — seven labels for six rungs; rung 1 distinguishes the coordinator slot
  // from a per-personality one. This is run_start.source widened, with 'global'
  // renamed 'default' in the same audit.
  it('carries all seven rung labels and no "global"', () => {
    const labels: ModelResolutionSource[] = [
      'run-override',
      'team-coordinator',
      'team-personality',
      'routing-override',
      'personality',
      'role-binding',
      'default',
    ];
    expect(labels).toHaveLength(7);
    expect(new Set(labels).size).toBe(7);

    // @ts-expect-error — 'global' was renamed 'default'; it is not a rung label.
    const renamed: ModelResolutionSource = 'global';
    expect(labels).not.toContain(renamed);
  });
});
