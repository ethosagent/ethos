import type { WizardAnswers, WizardStepId } from './reducer';

export interface DraftState {
  answers: WizardAnswers;
  step: WizardStepId;
  history: WizardStepId[];
}

const DRAFT_KEY = 'ethos:onboarding:draft';
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function saveDraft(state: DraftState): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const { apiKey: _, ...safeAnswers } = state.answers;
      const safeChain = safeAnswers.providersChain?.map(({ apiKey: _k, ...rest }) => rest);
      // Strip messaging platform secrets (bot tokens, signing secrets)
      // from the localStorage draft — they're submitted server-side via
      // rpc.platforms.set() and must not linger in plaintext storage.
      const safeMessaging =
        safeAnswers.messaging && !('skipped' in safeAnswers.messaging)
          ? { platform: safeAnswers.messaging.platform, fields: {} }
          : safeAnswers.messaging;
      const safe: DraftState = {
        ...state,
        answers: {
          ...safeAnswers,
          providersChain: safeChain as typeof state.answers.providersChain,
          messaging: safeMessaging as typeof state.answers.messaging,
        },
      };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(safe));
    } catch {
      // quota exceeded — silent skip
    }
  }, 250);
}

export function loadDraft(): DraftState | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as DraftState;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}
