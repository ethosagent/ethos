import { describe, expect, it } from 'vitest';
import {
  canTransition,
  EXPLORATION_TRANSITIONS,
  type ExplorationState,
  INITIATIVE_TRANSITIONS,
  type InitiativeState,
} from '../initiative';

const initiativeEdges: Array<['start' | InitiativeState, InitiativeState]> = [
  ['start', 'active'],
  ['start', 'self_started'],
  ['self_started', 'active'],
  ['self_started', 'stopped'],
  ['self_started', 'paused'],
  ['active', 'paused'],
  ['active', 'review'],
  ['paused', 'active'],
  ['review', 'active'],
  ['review', 'ended'],
];

const explorationEdges: Array<['start' | ExplorationState, ExplorationState]> = [
  ['start', 'idea'],
  ['idea', 'proposed'],
  ['proposed', 'exploring'],
  ['proposed', 'rejected'],
  ['exploring', 'briefed'],
  ['exploring', 'stalled'],
  ['stalled', 'briefed'],
  ['briefed', 'exploring'],
  ['briefed', 'adopted'],
  ['briefed', 'parked'],
];

describe('initiative state machines', () => {
  it('initiative transitions match the spec diagram', () => {
    for (const [from, to] of initiativeEdges) {
      expect(canTransition(INITIATIVE_TRANSITIONS, from, to), `${from} -> ${to}`).toBe(true);
    }
    const total = Object.values(INITIATIVE_TRANSITIONS).reduce((n, v) => n + v.length, 0);
    expect(total).toBe(initiativeEdges.length);
    expect(canTransition(INITIATIVE_TRANSITIONS, 'ended', 'active')).toBe(false);
    expect(canTransition(INITIATIVE_TRANSITIONS, 'stopped', 'active')).toBe(false);
  });

  it('exploration transitions match the spec diagram', () => {
    for (const [from, to] of explorationEdges) {
      expect(canTransition(EXPLORATION_TRANSITIONS, from, to), `${from} -> ${to}`).toBe(true);
    }
    const total = Object.values(EXPLORATION_TRANSITIONS).reduce((n, v) => n + v.length, 0);
    expect(total).toBe(explorationEdges.length);
    expect(canTransition(EXPLORATION_TRANSITIONS, 'proposed', 'adopted')).toBe(false);
    expect(canTransition(EXPLORATION_TRANSITIONS, 'briefed', 'exploring')).toBe(true);
  });

  it('canTransition is false for unknown source states', () => {
    expect(canTransition(INITIATIVE_TRANSITIONS, 'nope', 'active')).toBe(false);
  });
});
