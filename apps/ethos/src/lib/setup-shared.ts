import { join } from 'node:path';
import type { createInterface } from 'node:readline';
import { ethosDir, externalizeSecret } from '@ethosagent/config';
import type { KeylessPath } from '@ethosagent/wiring';
import { describeKeylessCandidate, type KeylessCandidate } from '@ethosagent/wiring/keyless-probe';
import { getDefaultModel } from '@ethosagent/wiring/model-catalog';
import type { getStorage } from '../wiring';

export const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

export function askRl(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

/** Providers that run against a local OpenAI-compatible endpoint: default the
 *  base URL to localhost, skip the API-key prompt, and offer the served model
 *  list from `GET /v1/models`. */
export const LOCAL_PROVIDERS = new Set(['ollama', 'vllm']);

/** Placeholder API key written for local endpoints, which ignore it. */
export const LOCAL_API_KEY = 'local';

export async function scaffoldEthosDir(storage: ReturnType<typeof getStorage>) {
  const dir = ethosDir();
  await storage.mkdir(join(dir, 'personalities'));
  for (const filename of ['MEMORY.md', 'USER.md']) {
    const path = join(dir, filename);
    if (!(await storage.exists(path))) {
      await storage.write(path, '');
    }
  }
}

export interface KeylessPreset {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  keylessPath: KeylessPath;
}

export function describeCandidate(cand: KeylessCandidate): string {
  const { label, hint } = describeKeylessCandidate(cand);
  return `${label} (${hint})`;
}

export function codexPreset(keylessPath: KeylessPath): KeylessPreset {
  return {
    provider: 'codex',
    model: getDefaultModel('codex')?.modelId ?? 'gpt-5.5-codex',
    apiKey: '',
    keylessPath,
  };
}

/** A local candidate writes the catalog base URL (with /v1) and the 'local' key (D14). */
export function localPreset(
  cand: Extract<KeylessCandidate, { kind: 'local' }>,
  model: string,
  path: KeylessPath,
): KeylessPreset {
  return {
    provider: cand.provider,
    model,
    apiKey: LOCAL_API_KEY,
    baseUrl: cand.baseUrl,
    keylessPath: path,
  };
}

/**
 * Store `value` under `ref` and return the reference for config.yaml — or
 * return `value` untouched when it already IS a reference. The wizard is seeded
 * with the config on disk, whose credentials are references, so a re-run that
 * leaves a field alone hands one straight back; storing it would replace the
 * real key with its own reference string. `externalizeSecret` is that
 * idempotent store. Pinned by `__tests__/setup-rerun-secrets.test.ts`.
 */
export async function storeSecret(
  secrets: import('@ethosagent/types').SecretsResolver,
  ref: string,
  value: string,
): Promise<string> {
  return externalizeSecret(value, ref, secrets);
}
