import type { ProviderConfig } from '@ethosagent/config';
import { createContext, type Dispatch, useContext } from 'react';

export type WizardMode = 'quick' | 'full';

export type WizardStepId =
  | 'keyless'
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
  memory?: 'markdown' | 'vector' | 'vault';
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
  /** The `providers:` chain, as `@ethosagent/config` models it — `region`,
   *  `awsProfile`, `apiVersion` and the unmodelled `passthrough` included. The
   *  wizard edits provider / key / model / baseUrl and carries the rest
   *  through; a narrower type here would let a future `.map()` drop a field
   *  the operator set with `ethos fallback add` or by hand. */
  providers?: ProviderConfig[];
  /** W2.5 three-way close outcome, set by LaunchStep:
   *   'gateway' → start the channel gateway; 'chat' → open CLI chat;
   *   'done' → exit. `undefined` until the launch step confirms. */
  launch?: 'gateway' | 'chat' | 'done';
  /** The validated Telegram `@username` (from the MessagingStep probe), reused
   *  in the LaunchStep gateway success block. Present only when a Telegram
   *  token validated during setup. */
  telegramUsername?: string;
  /** Steps the wizard walks past (`nextStep` / `prevStep`). Set by the keyless
   *  step when a candidate already answered provider/auth/model, and seeded
   *  with `['keyless']` for a re-run (D13). Pinned by
   *  `__tests__/keyless-step.test.ts` "skipSteps". */
  skipSteps?: WizardStepId[];
  /** The keyless step ended the wizard to run the Ollama install offer from
   *  setup.ts after Ink unmounts (inherited-stdio spawn is impractical inside Ink). */
  keylessInstall?: boolean;
  /** Which keyless candidate produced the answers (funnel `keylessPath`). */
  keylessPath?: 'ethos-login' | 'external-login' | 'local' | 'installed' | 'key';
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
  'keyless',
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
  'keyless',
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

export function nextStep(
  current: WizardStepId,
  mode: WizardMode,
  skip: readonly WizardStepId[] = [],
): WizardStepId | null {
  const order = getStepOrder(mode);
  for (let i = order.indexOf(current) + 1; i < order.length; i++) {
    const step = order[i];
    if (step !== undefined && !skip.includes(step)) return step;
  }
  return null;
}

export function prevStep(
  current: WizardStepId,
  mode: WizardMode,
  skip: readonly WizardStepId[] = [],
): WizardStepId | null {
  const order = getStepOrder(mode);
  for (let i = order.indexOf(current) - 1; i >= 0; i--) {
    const step = order[i];
    if (step !== undefined && !skip.includes(step)) return step;
  }
  return null;
}

export function isFullOnlyStep(step: WizardStepId): boolean {
  return ['provider-chain', 'key-rotation', 'memory', 'daemon'].includes(step);
}
