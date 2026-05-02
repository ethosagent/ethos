import { describe, expect, it } from 'vitest';
import type { WizardAction } from '../context';

// ---------------------------------------------------------------------------
// Inline the reducer under test — avoids React/Ink render setup in unit tests
// ---------------------------------------------------------------------------

type WizardMode = 'quick' | 'full';
type WizardStepId = 'entry' | 'provider' | 'auth' | 'model' | 'summary' | 'launch';

interface WizardState {
  step: WizardStepId;
  mode: WizardMode;
  answers: Record<string, unknown>;
  aborted: boolean;
  singleStep: boolean;
  singleStepDone: Record<string, unknown> | null;
}

const QUICK_STEPS: WizardStepId[] = ['entry', 'provider', 'auth', 'model', 'summary', 'launch'];

function nextStep(current: WizardStepId, _mode: WizardMode): WizardStepId | null {
  const order = QUICK_STEPS;
  const idx = order.indexOf(current);
  return order[idx + 1] ?? null;
}

function reducer(state: WizardState, action: WizardAction): WizardState {
  if (action.type === 'abort') return { ...state, aborted: true };
  const mode = (action.patch?.mode as WizardMode | undefined) ?? state.mode;
  if (action.type === 'next') {
    const merged = { ...state.answers, ...action.patch };
    if (state.singleStep) {
      return { ...state, mode, answers: merged, singleStepDone: merged };
    }
    const next = nextStep(state.step, mode);
    return { ...state, mode, answers: merged, step: next ?? state.step };
  }
  if (action.type === 'back') {
    const order = QUICK_STEPS;
    const idx = order.indexOf(state.step);
    return { ...state, step: idx > 0 ? (order[idx - 1] ?? state.step) : state.step };
  }
  return state;
}

const BASE: WizardState = {
  step: 'entry',
  mode: 'quick',
  answers: {},
  aborted: false,
  singleStep: false,
  singleStepDone: null,
};

describe('wizard reducer', () => {
  it('abort sets aborted flag', () => {
    const state = reducer(BASE, { type: 'abort' });
    expect(state.aborted).toBe(true);
    expect(state.step).toBe('entry');
  });

  it('abort preserves current answers', () => {
    const initial = { ...BASE, answers: { provider: 'openai' } };
    const state = reducer(initial, { type: 'abort' });
    expect(state.answers).toEqual({ provider: 'openai' });
  });

  it('next advances to the next step', () => {
    const state = reducer(BASE, { type: 'next', patch: {} });
    expect(state.step).toBe('provider');
    expect(state.aborted).toBe(false);
  });

  it('next merges patch into answers', () => {
    const state = reducer(BASE, { type: 'next', patch: { provider: 'anthropic' } });
    expect(state.answers).toEqual({ provider: 'anthropic' });
  });

  it('back goes to previous step', () => {
    const initial = { ...BASE, step: 'provider' as WizardStepId };
    const state = reducer(initial, { type: 'back' });
    expect(state.step).toBe('entry');
  });

  it('back at first step stays on entry', () => {
    const state = reducer(BASE, { type: 'back' });
    expect(state.step).toBe('entry');
  });

  describe('singleStep mode', () => {
    it('next sets singleStepDone instead of advancing', () => {
      const initial = { ...BASE, singleStep: true };
      const state = reducer(initial, { type: 'next', patch: { provider: 'groq' } });
      expect(state.singleStepDone).toEqual({ provider: 'groq' });
      expect(state.step).toBe('entry');
    });

    it('singleStepDone contains merged answers', () => {
      const initial = {
        ...BASE,
        singleStep: true,
        answers: { provider: 'anthropic', model: 'opus' },
      };
      const state = reducer(initial, { type: 'next', patch: { model: 'sonnet' } });
      expect(state.singleStepDone).toEqual({ provider: 'anthropic', model: 'sonnet' });
    });

    it('abort in singleStep still aborts', () => {
      const initial = { ...BASE, singleStep: true };
      const state = reducer(initial, { type: 'abort' });
      expect(state.aborted).toBe(true);
      expect(state.singleStepDone).toBeNull();
    });
  });
});
