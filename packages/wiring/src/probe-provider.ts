// probeProvider — shared live provider-credential probe (W2.2 / W2.4).
//
// One 1-token completion against the configured LLM, mirroring `ethos doctor
// --check-provider`, but with W1.2 liveness classification so every setup path
// (readline fallback, TUI AuthStep, `--from-env`) can distinguish a
// DEFINITIVELY rejected key (401/403 → re-enter / abort) from a transient
// outage (timeout/DNS/5xx/429 → save with a warning). Lives here because
// `createLLM` lives here and both apps/ethos and apps/tui depend on this
// package.

import type { LLMProvider } from '@ethosagent/types';
import { createLLM } from './index';

export interface ProbeProviderConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  apiVersion?: string;
}

export type ProbeProviderOutcome =
  | { ok: true; latencyMs: number }
  | { ok: false; reason: 'rejected' | 'unreachable'; error: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Best-effort HTTP status extraction from provider SDK errors. */
function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const candidate of [e.status, e.statusCode, e.response?.status]) {
    if (typeof candidate === 'number') return candidate;
  }
  return undefined;
}

/**
 * Classify a probe error. Only a DEFINITIVE auth rejection (401/403 or an
 * unmistakable auth message) counts as `rejected`; everything else — including
 * unknown/ambiguous errors — is `unreachable`, so a flaky network never blocks
 * a user behind a false "bad key" verdict (W1.2).
 */
export function classifyProbeError(err: unknown): 'rejected' | 'unreachable' {
  const status = extractStatus(err);
  if (status === 401 || status === 403) return 'rejected';
  if (status === 429 || (status !== undefined && status >= 500)) return 'unreachable';
  const m = errorMessage(err).toLowerCase();
  if (
    /\b401\b|\b403\b|unauthorized|forbidden|authentication|invalid[_ ]?api[_ ]?key|invalid x-api-key|permission_denied/.test(
      m,
    )
  ) {
    return 'rejected';
  }
  return 'unreachable';
}

export async function probeProvider(config: ProbeProviderConfig): Promise<ProbeProviderOutcome> {
  let llm: LLMProvider;
  try {
    llm = await createLLM(config);
  } catch (err) {
    // A construction failure (missing SDK, bad base URL) is not a credential
    // rejection — degrade rather than block.
    return { ok: false, reason: 'unreachable', error: errorMessage(err) };
  }
  const start = Date.now();
  try {
    for await (const _chunk of llm.complete([{ role: 'user', content: 'ping' }], [], {
      maxTokens: 1,
    })) {
      // drain — we only need to confirm the provider responds
    }
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, reason: classifyProbeError(err), error: errorMessage(err) };
  }
}
