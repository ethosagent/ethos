import { createContext, type Dispatch, useContext } from 'react';

export type WizardMode = 'quick' | 'full';

export type WizardStepId =
  | 'entry'
  | 'provider'
  | 'provider-chain'
  | 'auth'
  | 'key-rotation'
  | 'model'
  | 'memory'
  | 'personality'
  | 'messaging'
  | 'daemon'
  | 'summary'
  | 'launch';

/** All collected answers from the wizard. Passed back to the CLI as-is. */
export interface WizardAnswers {
  mode?: WizardMode;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Azure-only: REST API version. Defaults applied downstream; this field
   *  only carries an override entered during setup. */
  apiVersion?: string;
  personality?: string;
  memory?: 'markdown' | 'vector';
  telegramToken?: string;
  discordToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  emailImapHost?: string;
  emailImapPort?: number;
  emailUser?: string;
  emailPassword?: string;
  emailSmtpHost?: string;
  emailSmtpPort?: number;
  rotationKeys?: Array<{ apiKey: string; priority: number }>;
  providers?: Array<{ provider: string; apiKey: string; model?: string; baseUrl?: string }>;
  /** W2.5 three-way close outcome, set by LaunchStep:
   *   'gateway' → start the channel gateway; 'chat' → open CLI chat;
   *   'done' → exit. `undefined` until the launch step confirms. */
  launch?: 'gateway' | 'chat' | 'done';
  /** The validated Telegram `@username` (from the MessagingStep probe), reused
   *  in the LaunchStep gateway success block. Present only when a Telegram
   *  token validated during setup. */
  telegramUsername?: string;
}

export interface WizardAction {
  type: 'next' | 'back' | 'abort';
  patch?: Partial<WizardAnswers>;
}

export interface WizardContextValue {
  answers: WizardAnswers;
  accent: string;
  dispatch: Dispatch<WizardAction>;
}

export const WizardContext = createContext<WizardContextValue>({
  answers: {},
  accent: '#E8E8E6',
  dispatch: () => {},
});

export function useWizardContext(): WizardContextValue {
  return useContext(WizardContext);
}

const QUICK_STEPS: WizardStepId[] = [
  'entry',
  'provider',
  'auth',
  'model',
  'personality',
  'messaging',
  'summary',
  'launch',
];

const FULL_STEPS: WizardStepId[] = [
  'entry',
  'provider',
  'provider-chain',
  'auth',
  'key-rotation',
  'model',
  'memory',
  'personality',
  'messaging',
  'daemon',
  'summary',
  'launch',
];

export function getStepOrder(mode: WizardMode): WizardStepId[] {
  return mode === 'full' ? FULL_STEPS : QUICK_STEPS;
}

export function nextStep(current: WizardStepId, mode: WizardMode): WizardStepId | null {
  const order = getStepOrder(mode);
  const idx = order.indexOf(current);
  return order[idx + 1] ?? null;
}

export function prevStep(current: WizardStepId, mode: WizardMode): WizardStepId | null {
  const order = getStepOrder(mode);
  const idx = order.indexOf(current);
  return idx > 0 ? (order[idx - 1] ?? null) : null;
}

export function isFullOnlyStep(step: WizardStepId): boolean {
  return ['provider-chain', 'key-rotation', 'memory', 'daemon'].includes(step);
}
