import type { PlatformId, ProviderId } from '@ethosagent/web-contracts';

export type WizardMode = 'quick' | 'full';

export type WizardStepId =
  | 'setup-entry'
  | 'provider'
  | 'multi-provider' // full only
  | 'auth'
  | 'key-rotation' // full only
  | 'model'
  | 'memory' // full only
  | 'personality'
  | 'messaging'
  | 'daemon-hint' // full only
  | 'summary'
  | 'launch';

export type Direction = 'forward' | 'back';

export interface WizardAnswers {
  mode: WizardMode;
  provider?: ProviderId | 'openai';
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
  model?: string;
  personalityId?: string;
  messaging?: { platform: PlatformId; fields: Record<string, string> } | { skipped: true };
  providersChain?: Array<{ provider: ProviderId; apiKey: string; baseUrl?: string }>;
  keyPool?: Record<string, string[]>;
  memoryBackend?: 'markdown' | 'vector';
}

export interface WizardState {
  step: WizardStepId;
  direction: Direction;
  answers: WizardAnswers;
  history: WizardStepId[];
  draftLoadedFrom?: 'localStorage';
}

export type WizardEvent =
  | { type: 'next'; patch: Partial<WizardAnswers> }
  | { type: 'back' }
  | { type: 'jumpTo'; step: WizardStepId }
  | { type: 'reset' }
  | { type: 'hydrate'; draft: WizardAnswers; step: WizardStepId; history: WizardStepId[] };

const QUICK_STEPS: WizardStepId[] = [
  'setup-entry',
  'provider',
  'auth',
  'model',
  'personality',
  'messaging',
  'summary',
  'launch',
];
const FULL_STEPS: WizardStepId[] = [
  'setup-entry',
  'provider',
  'multi-provider',
  'auth',
  'key-rotation',
  'model',
  'memory',
  'personality',
  'messaging',
  'daemon-hint',
  'summary',
  'launch',
];

export const FULL_ONLY: Set<WizardStepId> = new Set([
  'multi-provider',
  'key-rotation',
  'memory',
  'daemon-hint',
]);

function stepsForMode(mode: WizardMode): WizardStepId[] {
  return mode === 'full' ? FULL_STEPS : QUICK_STEPS;
}

function nextStep(current: WizardStepId, mode: WizardMode): WizardStepId | null {
  const steps = stepsForMode(mode);
  const idx = steps.indexOf(current);
  if (idx === -1 || idx === steps.length - 1) return null;
  return steps[idx + 1] ?? null;
}

export const STEP_COUNT: Record<WizardMode, number> = {
  quick: QUICK_STEPS.length,
  full: FULL_STEPS.length,
};

export function stepIndex(step: WizardStepId, mode: WizardMode): number {
  return stepsForMode(mode).indexOf(step);
}

export const initialState: WizardState = {
  step: 'setup-entry',
  direction: 'forward',
  answers: { mode: 'quick' },
  history: [],
};

export function wizardReducer(state: WizardState, event: WizardEvent): WizardState {
  switch (event.type) {
    case 'next': {
      const answers = { ...state.answers, ...event.patch };
      const mode = (answers.mode as WizardMode) ?? state.answers.mode;
      const next = nextStep(state.step, mode);
      if (!next) return state;
      return {
        ...state,
        step: next,
        direction: 'forward',
        answers,
        history: [...state.history, state.step],
      };
    }
    case 'back': {
      if (state.history.length === 0) return state;
      const prev = state.history[state.history.length - 1];
      if (!prev) return state;
      return { ...state, step: prev, direction: 'back', history: state.history.slice(0, -1) };
    }
    case 'jumpTo': {
      return {
        ...state,
        step: event.step,
        direction: 'forward',
        history: [...state.history, state.step],
      };
    }
    case 'reset': {
      return initialState;
    }
    case 'hydrate': {
      return {
        step: event.step,
        direction: 'forward',
        answers: event.draft,
        history: event.history,
        draftLoadedFrom: 'localStorage',
      };
    }
  }
}
