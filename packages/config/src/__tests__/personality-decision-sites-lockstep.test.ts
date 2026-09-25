// Plan decision-provider-personality §4.1 / §11 — `@ethosagent/types` has zero
// deps, so it spells the personality's decision site ids and modes as literal
// unions. This file pins them equal to the operator-side constants in
// ./decisions (`DECISION_SITES` / `DECISION_SITE_MODES`): at compile time in
// both directions, and at runtime against the arrays.

import type { PersonalityDecisionSiteId, PersonalityDecisionSiteMode } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  DECISION_SITE_MODES,
  DECISION_SITES,
  type DecisionSiteId,
  type DecisionSiteMode,
} from '../index';

// Compile-time: each union is assignable to the other (tsc fails otherwise).
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sitesEqual: Equal<PersonalityDecisionSiteId, DecisionSiteId> = true;
const modesEqual: Equal<PersonalityDecisionSiteMode, DecisionSiteMode> = true;

// Runtime: a Record over the types' union must list every member, so its keys
// are the union's members.
const TYPES_SITES: Record<PersonalityDecisionSiteId, true> = {
  injection: true,
  approver: true,
  router: true,
};
const TYPES_MODES: Record<PersonalityDecisionSiteMode, true> = {
  off: true,
  shadow: true,
  on: true,
};

describe('personality decision sites/modes lockstep', () => {
  it('the type-level equality holds', () => {
    expect(sitesEqual).toBe(true);
    expect(modesEqual).toBe(true);
  });

  it('DECISION_SITES equals PersonalityDecisionSiteId', () => {
    expect([...DECISION_SITES].sort()).toEqual(Object.keys(TYPES_SITES).sort());
  });

  it('DECISION_SITE_MODES equals PersonalityDecisionSiteMode', () => {
    expect([...DECISION_SITE_MODES].sort()).toEqual(Object.keys(TYPES_MODES).sort());
  });
});
