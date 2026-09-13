// probeProvider — shared live provider-credential probe (W2.2 / W2.4).
//
// One 1-token completion against the configured LLM, mirroring `ethos doctor
// --check-provider`, but with W1.2 liveness classification so every setup path
// (readline fallback, TUI AuthStep, `--from-env`) can distinguish a
// DEFINITIVELY rejected key (401/403 → re-enter / abort) from a transient
// outage (timeout/DNS/5xx/429 → save with a warning). Lives here because
// `createLLM` lives here and both apps/ethos and apps/tui depend on this
// package.

import type { CompletionChunk, CompletionOptions, LLMProvider } from '@ethosagent/types';
import { createLLM } from './index';

export interface ProbeProviderConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  apiVersion?: string;
  /**
   * Abort the probe after this many milliseconds and report `unreachable`.
   * Absent means no bound — the pre-existing behaviour every setup path has.
   *
   * A timeout is `unreachable`, never `rejected`: a probe that never got an
   * answer learned nothing about the key (W1.2).
   */
  timeoutMs?: number;
}

export type ProbeProviderOutcome =
  | {
      ok: true;
      latencyMs: number;
      /**
       * The model id the PROVIDER reported serving, when it reported one —
       * `claude-sonnet-5-20260114` for a request that said `claude-sonnet-5`
       * (T1.23 / D19).
       *
       * Read from the `usage` chunk's `metadata.model`, which is the only slot
       * on `CompletionChunk` (`packages/types/src/llm.ts`) that can carry it.
       * **No shipped transport populates it today** — every one of them emits
       * `metadata: {}` (anthropic, openai-compat, bedrock, codex; gemini builds
       * its usage chunk in `geminiUsage`) — so in practice this field is absent
       * and the surfaces that render it print nothing extra. It is captured
       * here rather than left unwritten so that a transport which starts
       * reporting the served model surfaces it without a second change, and so
       * the "print it only when it differs" rule has one implementation.
       */
      echoedModel?: string;
    }
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
  // Only KEY-SPECIFIC phrases count as rejected. Bare `forbidden` /
  // `authentication` / `permission_denied` are dropped on purpose: providers
  // return them for feature-flag and regional denials on a perfectly valid
  // key, and misclassifying those as `rejected` makes `--from-env` abort a
  // good deploy.
  if (
    /\b401\b|\b403\b|\bunauthorized\b|\binvalid[_ ]?api[_ ]?key\b|invalid x-api-key|\bauthentication[_ ]?failed\b/.test(
      m,
    )
  ) {
    return 'rejected';
  }
  return 'unreachable';
}

/** The model a chunk says the provider served, or `undefined`. See
 *  `ProbeProviderOutcome.echoedModel` for why this is the only place to look. */
function echoedModelOf(chunk: CompletionChunk): string | undefined {
  if (chunk.type !== 'usage') return undefined;
  const reported = chunk.metadata?.model;
  return typeof reported === 'string' && reported.length > 0 ? reported : undefined;
}

/** Race sentinel — a unique object, so it can never collide with a drain result. */
const TIMED_OUT = Symbol('probe-timed-out');

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
  const bounded = config.timeoutMs !== undefined;
  const controller = bounded ? new AbortController() : undefined;
  const options: CompletionOptions = {
    maxTokens: 1,
    ...(controller ? { abortSignal: controller.signal } : {}),
  };

  // One token, drained to exhaustion — we only need to confirm the provider
  // answers, and the model it says it answered with.
  const drain = (async (): Promise<string | undefined> => {
    let echoed: string | undefined;
    for await (const chunk of llm.complete([{ role: 'user', content: 'ping' }], [], options)) {
      echoed ??= echoedModelOf(chunk);
    }
    return echoed;
  })();

  const timeoutMs = config.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (timeoutMs !== undefined) {
      const raced = await Promise.race([
        drain,
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        }),
      ]);
      if (raced === TIMED_OUT) {
        controller?.abort();
        // The drain rejects once the abort lands and nothing awaits it any more.
        drain.catch(() => {});
        return {
          ok: false,
          reason: 'unreachable',
          // Lower-case and unpunctuated on purpose: surfaces compose it into a
          // sentence — `could not reach anthropic (timed out after 10s).`
          // Sub-second bounds are named in ms rather than rounded down to `0s`.
          error: `timed out after ${
            timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`
          }`,
        };
      }
      return { ok: true, latencyMs: Date.now() - start, ...(raced ? { echoedModel: raced } : {}) };
    }
    const echoedModel = await drain;
    return {
      ok: true,
      latencyMs: Date.now() - start,
      ...(echoedModel ? { echoedModel } : {}),
    };
  } catch (err) {
    return { ok: false, reason: classifyProbeError(err), error: errorMessage(err) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
