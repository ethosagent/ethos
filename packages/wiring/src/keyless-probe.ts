// ---------------------------------------------------------------------------
// Keyless probe (plan keyless-first-run §3.2, D2–D7)
//
// Looks for a way to answer a first turn without a pasted key, in a fixed
// order: ethos-held login → external Codex/Hermes login → local server →
// install offer → paste key. All hits are returned; candidates[recommended]
// is the first.
//
// Guarantees (each pinned by __tests__/keyless-probe.test.ts):
//  - never writes: "a ~/.codex/auth.json is reported as external-login and
//    nothing is written to secrets";
//  - no token material in the result: "the result carries no token material"
//    (and `KeylessCandidate` has no token field by construction);
//  - only 127.0.0.1 is probed: "only 127.0.0.1 is probed";
//  - never throws: "probe never throws on fetch rejection, secrets failure or timeout".
// ---------------------------------------------------------------------------

import { homedir } from 'node:os';
import { CodexTokenStore, detectExternalLogin } from '@ethosagent/llm-codex';
import { LOCAL_CONTEXT_FLOOR_TOKENS } from '@ethosagent/llm-openai-compat';
import type { SecretsResolver } from '@ethosagent/types';
import { type KeylessModelPick, pickKeylessModel } from './keyless-models';
import { fetchLocalModels, type LocalRuntime, probeServedWindow } from './local-models';
import { type OllamaInstallPlan, ollamaInstallPlan } from './ollama-install-plan';
import { getProvider } from './provider-catalog';

export {
  KEYLESS_MODEL_IDS,
  type KeylessModelId,
  type KeylessModelPick,
  pickKeylessModel,
} from './keyless-models';

export type KeylessCandidate =
  | { kind: 'external-login'; source: 'codex-cli' | 'hermes'; provider: 'codex'; path: string }
  | { kind: 'ethos-login'; provider: 'codex' }
  | {
      kind: 'local';
      runtime: LocalRuntime;
      provider: 'ollama' | 'vllm' | 'openai-compat';
      baseUrl: string;
      models: string[];
      contextWindow?: number;
      /**
       * Set when the served window is known and under the floor. The first turn
       * with this candidate would throw at provider init: enforced by the
       * `LOCAL_CONTEXT_FLOOR_TOKENS` check in
       * extensions/llm-openai-compat/src/index.ts; the flagging and the
       * recommendation rule are pinned by __tests__/keyless-probe.test.ts
       * ("below-floor ..."). An UNKNOWN window is never flagged: Ollama's
       * /api/ps lists only loaded models, so a model that is not loaded
       * reports nothing (a known limitation; the first turn still fails loudly).
       */
      belowContextFloor?: { servedTokens: number; floorTokens: number };
    }
  | { kind: 'install-offer'; plan: OllamaInstallPlan; model: KeylessModelPick }
  | { kind: 'paste-key' };

export interface KeylessProbeResult {
  candidates: KeylessCandidate[];
  /** Index into `candidates`: the first that answers. */
  recommended: number;
}

export interface KeylessProbeOptions {
  secrets: SecretsResolver;
  platform: NodeJS.Platform;
  totalMemBytes: number;
  isRoot: boolean;
  fetchImpl?: typeof fetch;
  /** Home directory holding `.codex` / `.hermes`. Defaults to the OS home. */
  home?: string;
  /** Whether `brew` is on PATH (macOS install plan). Default false. */
  hasBrew?: boolean;
  /** Override the computed install plan (tests, callers with their own). */
  installPlan?: OllamaInstallPlan;
}

const LOOPBACK = '127.0.0.1';

interface LocalTarget {
  runtime: LocalRuntime;
  provider: 'ollama' | 'vllm' | 'openai-compat';
  baseUrl: string;
}

/** Catalog default for a row, with the host pinned to 127.0.0.1 (D7). */
function loopbackFromCatalog(id: string, fallbackPort: number): string {
  const catalog = getProvider(id)?.defaultBaseUrl;
  const raw = catalog ?? `http://${LOOPBACK}:${fallbackPort}/v1`;
  const url = new URL(raw);
  url.hostname = LOOPBACK;
  return url.href.replace(/\/$/, '');
}

function localTargets(): LocalTarget[] {
  return [
    { runtime: 'ollama', provider: 'ollama', baseUrl: loopbackFromCatalog('ollama', 11434) },
    { runtime: 'vllm', provider: 'vllm', baseUrl: loopbackFromCatalog('vllm', 8000) },
    { runtime: 'llamacpp', provider: 'openai-compat', baseUrl: `http://${LOOPBACK}:8080/v1` },
    { runtime: 'lmstudio', provider: 'openai-compat', baseUrl: `http://${LOOPBACK}:1234/v1` },
  ];
}

async function probeLogins(opts: KeylessProbeOptions, home: string): Promise<KeylessCandidate[]> {
  const out: KeylessCandidate[] = [];
  const store = new CodexTokenStore(opts.secrets, { home });
  try {
    if ((await store.peek()) !== null) return [{ kind: 'ethos-login', provider: 'codex' }];
  } catch {
    // An unreadable vault is "no ethos login"; keep probing.
  }
  for (const source of ['codex-cli', 'hermes'] as const) {
    try {
      const path = store.externalPath(source);
      if (await detectExternalLogin(path)) {
        out.push({ kind: 'external-login', source, provider: 'codex', path });
      }
    } catch {
      // detectExternalLogin already swallows; belt and braces for the contract.
    }
  }
  return out;
}

async function probeLocal(opts: KeylessProbeOptions): Promise<KeylessCandidate[]> {
  const hits = await Promise.all(
    localTargets().map(async (t): Promise<KeylessCandidate | null> => {
      try {
        const { reachable, models } = await fetchLocalModels(t.baseUrl, {
          fetchImpl: opts.fetchImpl,
        });
        if (!reachable || models.length === 0) return null;
        return { kind: 'local', ...t, models };
      } catch {
        return null;
      }
    }),
  );
  const found = hits.filter((c): c is Extract<KeylessCandidate, { kind: 'local' }> => c !== null);
  const first = found[0];
  const firstModel = first?.models[0];
  if (first && firstModel) {
    try {
      const w = await probeServedWindow({
        runtime: first.runtime,
        baseUrl: first.baseUrl,
        model: firstModel,
        fetchImpl: opts.fetchImpl,
      });
      if (w.contextWindow !== undefined) {
        first.contextWindow = w.contextWindow;
        if (w.contextWindow < LOCAL_CONTEXT_FLOOR_TOKENS) {
          first.belowContextFloor = {
            servedTokens: w.contextWindow,
            floorTokens: LOCAL_CONTEXT_FLOOR_TOKENS,
          };
        }
      }
    } catch {
      // Window stays unknown.
    }
  }
  return found;
}

export async function probeKeyless(opts: KeylessProbeOptions): Promise<KeylessProbeResult> {
  const home = opts.home ?? homedir();
  const candidates: KeylessCandidate[] = [];

  candidates.push(...(await probeLogins(opts, home)));

  const local = await probeLocal(opts);
  candidates.push(...local);

  if (local.length === 0) {
    const plan =
      opts.installPlan ??
      ollamaInstallPlan(opts.platform, { hasBrew: opts.hasBrew ?? false, isRoot: opts.isRoot });
    candidates.push({ kind: 'install-offer', plan, model: pickKeylessModel(opts.totalMemBytes) });
  }

  candidates.push({ kind: 'paste-key' });
  return { candidates, recommended: recommend(candidates) };
}

/**
 * First candidate, except a below-floor local one yields to any other
 * non-install, non-paste-key candidate (it stays listed). With nothing better
 * it stays first. Pinned by keyless-probe.test.ts ("below-floor ...").
 */
function recommend(candidates: KeylessCandidate[]): number {
  if (!isBelowFloor(candidates[0])) return 0;
  const better = candidates.findIndex(
    (c) => c.kind !== 'install-offer' && c.kind !== 'paste-key' && !isBelowFloor(c),
  );
  return better === -1 ? 0 : better;
}

/** True for a local candidate whose known served window is under the floor. */
export function isBelowFloor(c: KeylessCandidate | undefined): boolean {
  return c?.kind === 'local' && c.belowContextFloor !== undefined;
}

/**
 * Remediation for a below-floor local candidate. `OLLAMA_CONTEXT_LENGTH` is
 * BELIEVED to be Ollama's server-wide context setting; it is not verified
 * against an Ollama release here, so the copy says "e.g.". Ethos never sets
 * num_ctx itself (plan D9).
 */
export function belowFloorHint(c: Extract<KeylessCandidate, { kind: 'local' }>): string | null {
  const b = c.belowContextFloor;
  if (!b) return null;
  const fix =
    c.runtime === 'ollama'
      ? 'restart Ollama with a larger context (e.g. OLLAMA_CONTEXT_LENGTH=16384)'
      : 'raise its context length (--max-model-len / -c / model settings)';
  return `serves ${b.servedTokens} tokens; Ethos needs ${b.floorTokens} — ${fix}, then choose this again`;
}

/** The consent copy of plan keyless-first-run §3.2, verbatim (the web step keeps its own copy: no wiring in the browser). */
export const CODEX_IMPORT_CONSENT =
  'Ethos will copy your Codex sign-in into its own secret store. Both apps will then share one sign-in. When either app refreshes it, the other can be signed out. To keep them separate, choose "Sign in with ChatGPT" instead.';

/** One display label and hint per candidate, shared by the TUI wizard and the readline path. */
export function describeKeylessCandidate(c: KeylessCandidate): { label: string; hint: string } {
  switch (c.kind) {
    case 'ethos-login':
      return { label: 'Use your ChatGPT sign-in', hint: 'already signed in to Ethos' };
    case 'external-login':
      return {
        label: c.source === 'hermes' ? 'Use your Hermes sign-in' : 'Use your Codex sign-in',
        hint: 'found on this machine; nothing is copied until you agree',
      };
    case 'local':
      return {
        label: `${c.runtime} · ${c.models[0] ?? 'local model'}`,
        hint: belowFloorHint(c) ?? `running at ${c.baseUrl}`,
      };
    case 'install-offer':
      return {
        label: `Install Ollama and download ${c.model.modelId}`,
        hint: `about ${c.model.approxDownloadGb} GB; asks before each step`,
      };
    case 'paste-key':
      return { label: 'Paste an API key', hint: 'any provider' };
  }
}

// CLI setup seams (consented import, connector presets): see ./keyless-setup.
export * from './keyless-setup';
