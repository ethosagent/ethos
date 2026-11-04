// ---------------------------------------------------------------------------
// Pure planning for the keyless setup step (plan keyless-first-run §3.5, D13,
// D14). No Ink, no I/O except `defaultKeylessProbe`, so every rule below is
// testable without a render: apps/tui/src/setup/__tests__/keyless-step.test.ts.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { totalmem } from 'node:os';
import { ethosDir } from '@ethosagent/config';
import type { SecretsResolver } from '@ethosagent/types';
import {
  CODEX_IMPORT_CONSENT,
  describeKeylessCandidate,
  type KeylessCandidate,
  type KeylessProbeResult,
  openFileVault,
  probeKeyless,
} from '@ethosagent/wiring/keyless-probe';
import { getDefaultModel } from '@ethosagent/wiring/model-catalog';
import type { WizardAnswers, WizardStepId } from './context';
import { LOCAL_API_KEY_PLACEHOLDER } from './local-provider';

export { CODEX_IMPORT_CONSENT };

export interface KeylessRow {
  id: string;
  label: string;
  hint: string;
  candidate: KeylessCandidate;
}

/** Rows in display order: the recommended candidate first, the rest as probed. */
export function buildKeylessRows(
  result: KeylessProbeResult,
  opts: { offerInstall?: boolean } = {},
): KeylessRow[] {
  const rec = result.candidates[result.recommended];
  const ordered = rec
    ? [rec, ...result.candidates.filter((_, i) => i !== result.recommended)]
    : [...result.candidates];
  return ordered
    .filter((c) => c.kind !== 'install-offer' || opts.offerInstall !== false)
    .map((candidate, i) => ({
      id: `${candidate.kind}-${i}`,
      candidate,
      ...describeKeylessCandidate(candidate),
    }));
}

const SKIP_PROVIDER_AUTH_MODEL: WizardStepId[] = ['provider', 'auth', 'model'];

/** Answers for a candidate that already settled provider, auth and model. D14:
 *  a local candidate writes the catalog base URL (with /v1) and the 'local'
 *  placeholder key. Returns null for a candidate that settles nothing. */
export function answersForCandidate(c: KeylessCandidate): Partial<WizardAnswers> | null {
  if (c.kind === 'local') {
    // Below the floor the first turn would throw (llm-openai-compat floor
    // check): settle nothing. Pinned by keyless-step.test.ts.
    if (c.belowContextFloor) return null;
    return {
      provider: c.provider,
      baseUrl: c.baseUrl,
      apiKey: LOCAL_API_KEY_PLACEHOLDER,
      model: c.models[0],
      skipSteps: SKIP_PROVIDER_AUTH_MODEL,
      keylessPath: 'local',
    };
  }
  if (c.kind === 'ethos-login') return codexLoginAnswers('ethos-login');
  return null;
}

/** A Codex login now sits in the Ethos vault (existing, or imported on a yes). */
export function codexLoginAnswers(path: 'ethos-login' | 'external-login'): Partial<WizardAnswers> {
  return {
    provider: 'codex',
    apiKey: '',
    model: getDefaultModel('codex')?.modelId,
    skipSteps: SKIP_PROVIDER_AUTH_MODEL,
    keylessPath: path,
  };
}

/** "Sign in with ChatGPT": the existing device flow (AuthStep) runs, its own grant. */
export function deviceSignInAnswers(): Partial<WizardAnswers> {
  return { provider: 'codex', skipSteps: ['provider'], keylessPath: 'ethos-login' };
}

/** "Paste a key" falls through to entry → provider → auth. */
export function pasteKeyAnswers(): Partial<WizardAnswers> {
  return { skipSteps: [], keylessPath: 'key' };
}

/** D13: the step runs only on a fresh setup. */
export function shouldRunKeylessStep(
  existing: WizardAnswers | null,
  startAtStep?: WizardStepId,
): boolean {
  return existing === null && startAtStep === undefined;
}

function hasBrew(): boolean {
  try {
    return spawnSync('brew', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

export function keylessSecrets(): SecretsResolver {
  return openFileVault(ethosDir());
}

/** The real probe the Ink step runs. */
export function defaultKeylessProbe(): Promise<KeylessProbeResult> {
  return probeKeyless({
    secrets: keylessSecrets(),
    platform: process.platform,
    totalMemBytes: totalmem(),
    isRoot: process.getuid?.() === 0,
    hasBrew: hasBrew(),
  });
}
