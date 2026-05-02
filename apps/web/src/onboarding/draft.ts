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
      localStorage.setItem(DRAFT_KEY, JSON.stringify(state));
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
