import type { PlatformId, ProviderId } from '@ethosagent/web-contracts';

export type WizardMode = 'quick' | 'full';

export type WizardStepId =
  | 'keyless' // ahead of setup-entry: found-model offer (plan keyless-first-run §3.5)
  | 'setup-entry'
  | 'provider'
  | 'multi-provider' // full only
  | 'auth'
  | 'key-rotation' // full only
  | 'model'
  | 'memory' // full only
  | 'personality'
  | 'name-agent' // born copy of the picked built-in (D15); skipped by "keep the built-in" (Q3)
  | 'connectors' // attach no-auth / OAuth MCP presets to the born agent (§5.2)
  | 'messaging'
  | 'daemon-hint' // full only
  | 'summary'
  | 'launch';

/** Which keyless route produced the model; sent to `onboarding.complete` for the funnel. */
export type KeylessPath = 'ethos-login' | 'external-login' | 'local' | 'installed' | 'key';

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
  keylessPath?: KeylessPath;
  /** The built-in picked in the personality step; `personalityId` becomes the born copy's id. */
  builtInPersonalityId?: string;
  /** Display name given to the born copy (button copy in the connectors step). */
  agentName?: string;
  /** Q3: the user kept the built-in, so naming and connectors are skipped. */
  keepBuiltIn?: boolean;
  /** Names of MCP presets connected in the connectors step (drives first-task suggestions). */
  connectedPresets?: string[];
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

// Order: keyless → (setup-entry → provider → auth → model, unless a keyless
// candidate already supplied the model) → personality → name-agent →
// connectors → messaging → summary. name-agent and connectors sit right after
// the personality pick because connectors need the born, user-owned copy
// (built-ins are read-only, plan §4.1) and both are Skip-able.
const QUICK_STEPS: WizardStepId[] = [
  'keyless',
  'setup-entry',
  'provider',
  'auth',
  'model',
  'personality',
  'name-agent',
  'connectors',
  'messaging',
  'summary',
  'launch',
];
const FULL_STEPS: WizardStepId[] = [
  'keyless',
  'setup-entry',
  'provider',
  'multi-provider',
  'auth',
  'key-rotation',
  'model',
  'memory',
  'personality',
  'name-agent',
  'connectors',
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

function nextStep(
  current: WizardStepId,
  mode: WizardMode,
  answers: WizardAnswers,
): WizardStepId | null {
  if (current === 'keyless') {
    // "Paste a key" (or no pick) falls through to the existing flow.
    if (!answers.keylessPath || answers.keylessPath === 'key' || !answers.provider) {
      return 'setup-entry';
    }
    // A candidate that already holds a model skips setup-entry/provider/auth/model.
    if (answers.model) return 'personality';
    // A found login supplied the model list but no pick yet: choose one.
    if (answers.models?.length) return 'model';
    // Sign in with ChatGPT: the existing device flow lives in the auth step.
    return answers.provider === 'codex' ? 'auth' : 'setup-entry';
  }
  // Q3: keeping the built-in skips naming and connectors.
  if (current === 'name-agent' && answers.keepBuiltIn) return 'messaging';
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
  step: 'keyless',
  direction: 'forward',
  answers: { mode: 'quick' },
  history: [],
};

/** D13: when the server already holds a provider, skip ONLY the keyless probe
 *  and start at the original wizard start (`setup-entry`); provider, auth and
 *  model still run so `complete` has its answers. Null = start at `keyless`.
 *  Pinned by __tests__/reducer.test.ts. */
export function serverStartStep(server: {
  step: string;
  hasProvider: boolean;
}): WizardStepId | null {
  return server.hasProvider && server.step !== 'welcome' ? 'setup-entry' : null;
}

export function wizardReducer(state: WizardState, event: WizardEvent): WizardState {
  switch (event.type) {
    case 'next': {
      const answers = { ...state.answers, ...event.patch };
      const mode = (answers.mode as WizardMode) ?? state.answers.mode;
      const next = nextStep(state.step, mode, answers);
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
