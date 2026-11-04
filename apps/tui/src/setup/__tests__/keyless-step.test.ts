// Plan keyless-first-run §3.6. Authored as .test.ts with createElement: the
// root vitest glob does not run .tsx tests. The step's decisions live in
// keyless-plan.ts / context.ts so they are tested without an Ink render; the
// element itself is only constructed here.

import type { KeylessCandidate } from '@ethosagent/wiring/keyless-probe';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { getStepOrder, nextStep, prevStep, type WizardAnswers } from '../context';
import {
  answersForCandidate,
  buildKeylessRows,
  CODEX_IMPORT_CONSENT,
  codexLoginAnswers,
  deviceSignInAnswers,
  shouldRunKeylessStep,
} from '../keyless-plan';
import { LOCAL_API_KEY_PLACEHOLDER } from '../local-provider';
import { KeylessStep } from '../steps/KeylessStep';
import { initialStep } from '../Wizard';

const local: KeylessCandidate = {
  kind: 'local',
  runtime: 'ollama',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  models: ['llama3.2:latest'],
};
const login: KeylessCandidate = {
  kind: 'external-login',
  source: 'codex-cli',
  provider: 'codex',
  path: '/home/u/.codex/auth.json',
};
const install: KeylessCandidate = {
  kind: 'install-offer',
  plan: {
    command: 'curl -fsSL https://ollama.com/install.sh | sh',
    argv: ['sh', '-c', 'curl -fsSL https://ollama.com/install.sh | sh'],
    notes: 'n',
    downloadUrl: null,
    runnable: true,
  } as never,
  model: { modelId: 'llama3.2', approxDownloadGb: 2, reason: 'r' },
};
const paste: KeylessCandidate = { kind: 'paste-key' };

describe('keyless step', () => {
  it('below-floor local settles nothing and its row carries the remediation', () => {
    const low: KeylessCandidate = {
      ...local,
      belowContextFloor: { servedTokens: 8192, floorTokens: 16000 },
    };
    expect(answersForCandidate(low)).toBeNull();
    const rows = buildKeylessRows({ candidates: [low, paste], recommended: 0 });
    expect(rows[0]?.hint).toMatch(/serves 8192 tokens; Ethos needs 16000/);
  });

  it('recommended candidate is first', () => {
    const rows = buildKeylessRows({ candidates: [login, local, install, paste], recommended: 1 });
    expect(rows[0]?.candidate).toBe(local);
    expect(rows.map((r) => r.candidate.kind)).toEqual([
      'local',
      'external-login',
      'install-offer',
      'paste-key',
    ]);
  });

  it('hides the install row when the install offer was already tried', () => {
    const rows = buildKeylessRows(
      { candidates: [install, paste], recommended: 0 },
      { offerInstall: false },
    );
    expect(rows.map((r) => r.candidate.kind)).toEqual(['paste-key']);
  });

  it('choosing local skips provider/auth/model', () => {
    const patch = answersForCandidate(local);
    expect(patch).toMatchObject({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: LOCAL_API_KEY_PLACEHOLDER,
      model: 'llama3.2:latest',
      keylessPath: 'local',
    });
    const answers: WizardAnswers = { ...patch };
    expect(nextStep('entry', 'quick', answers.skipSteps)).toBe('personality');
    expect(nextStep('entry', 'full', answers.skipSteps)).toBe('provider-chain');
    expect(prevStep('personality', 'quick', answers.skipSteps)).toBe('entry');
  });

  it('a codex sign-in settles provider and model; the device flow keeps the auth step', () => {
    expect(codexLoginAnswers('external-login')).toMatchObject({
      provider: 'codex',
      skipSteps: ['provider', 'auth', 'model'],
      keylessPath: 'external-login',
    });
    const device = deviceSignInAnswers();
    expect(device.keylessPath).toBe('ethos-login');
    expect(nextStep('entry', 'quick', device.skipSteps)).toBe('auth');
  });

  it('re-run with existing config skips the step', () => {
    const existing: WizardAnswers = { provider: 'anthropic' };
    expect(shouldRunKeylessStep(existing)).toBe(false);
    expect(shouldRunKeylessStep(null, 'model')).toBe(false);
    expect(shouldRunKeylessStep(null)).toBe(true);
    expect(initialStep(existing)).toBe('entry');
    expect(initialStep(null)).toBe('keyless');
  });

  it('is the first step of both modes, ahead of entry', () => {
    expect(getStepOrder('quick').slice(0, 2)).toEqual(['keyless', 'entry']);
    expect(getStepOrder('full').slice(0, 2)).toEqual(['keyless', 'entry']);
  });

  it('skipSteps: back from entry on a re-run never lands on keyless', () => {
    expect(prevStep('entry', 'quick', ['keyless'])).toBeNull();
  });

  it('shows the consent copy verbatim and builds as an element', () => {
    expect(CODEX_IMPORT_CONSENT).toBe(
      'Ethos will copy your Codex sign-in into its own secret store. Both apps will then share one sign-in. When either app refreshes it, the other can be signed out. To keep them separate, choose "Sign in with ChatGPT" instead.',
    );
    const el = createElement(KeylessStep, { onComplete: () => {}, offerInstall: true });
    expect(el.type).toBe(KeylessStep);
  });
});
