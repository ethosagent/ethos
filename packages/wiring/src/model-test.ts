// On-demand model test — the D19 probe path, unwrapped (T1.23 / T1.24).
//
// ONE function behind two front doors: `ethos models test <alias>` and the
// `modelRegistry.test` RPC both call `testModelAlias`, so a headless CLI and a
// browser share one definition of what a test is and cannot drift before D18
// wraps this path in a cache (T2.13).
//
// D28 is the whole shape of this module: "A user-initiated test has no cache,
// no TTL, no detached execution and no cross-process contention. Someone
// clicked, one probe ran, its outcome is rendered." There is deliberately no
// health record, no `~/.ethos/cache/model-health.json`, and no scheduling here.

import {
  deriveProviderKey,
  type EthosConfig,
  type ProviderChainEntry,
  resolveSecretRef,
} from '@ethosagent/config';
import type { ModelRegistry, SecretsResolver } from '@ethosagent/types';
import {
  type ProbeProviderConfig,
  type ProbeProviderOutcome,
  probeProvider,
} from './probe-provider';

/** The bound every test runs under. One token, ten seconds, then `unreachable`. */
export const MODEL_TEST_TIMEOUT_MS = 10_000;

/** One test per alias per caller per this many milliseconds (D19). */
export const MODEL_TEST_WINDOW_MS = 10_000;

/** The probe seam. Defaults to the real `probeProvider`; tests inject a stub. */
export type ModelTestProbe = (config: ProbeProviderConfig) => Promise<ProbeProviderOutcome>;

/**
 * What a test learned. The SAME value both front doors render — the CLI prints
 * it, the RPC returns it — which is what `the CLI and the RPC return the same
 * outcome for the same alias` pins.
 */
export type ModelTestOutcome =
  | {
      state: 'ok';
      alias: string;
      providerKey: string;
      /** The provider TYPE (`anthropic`), for the "could not reach X" sentence. */
      provider: string;
      modelId: string;
      latencyMs: number;
      /** Present only when the provider named a model; see `ProbeProviderOutcome`. */
      echoedModel?: string;
    }
  | {
      state: 'rejected';
      alias: string;
      providerKey: string;
      provider: string;
      modelId: string;
      /** The vendor's own words, verbatim and untruncated. */
      error: string;
      fix: string;
    }
  | {
      state: 'unreachable';
      alias: string;
      providerKey: string;
      provider: string;
      modelId: string;
      /** The transport's own words, verbatim and untruncated. */
      error: string;
    }
  | {
      /** Nothing was probed: the alias, its provider entry or its credential is missing. */
      state: 'unconfigured';
      alias: string;
      reason: string;
      fix?: string;
    }
  | { state: 'rate_limited'; alias: string; retryAfterSeconds: number };

export interface ModelTestRequest {
  /** The registry alias to test. */
  alias: string;
  config: EthosConfig;
  secrets: SecretsResolver;
  /**
   * Who is asking. The rate-limit bucket is `(caller, alias)` — the CLI passes
   * `'cli'`, the RPC handler passes whatever identity the request carries.
   */
  caller: string;
  /** Defaults to the process-wide {@link modelTestRateLimiter}. */
  limiter?: ModelTestRateLimiter;
  probe?: ModelTestProbe;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

/**
 * One test per `(caller, alias)` per window.
 *
 * A test is a real billable completion against the operator's key, reachable by
 * anything that can call the RPC, so the limit is enforced HERE — in the path
 * both front doors take — rather than in a button (D19). The client-side
 * disable (T2.8) sits on top of this as UX, so the ordinary path never meets
 * the refusal.
 *
 * **Per process, and that is the limitation.** The state is one in-memory Map:
 * it bounds a browser tab, a stuck retry loop and a re-rendering component,
 * which are the cases D19 names, and it bounds repeated tests inside ONE CLI
 * invocation. It does NOT bound a shell loop that spawns `ethos models test`
 * afresh each time — each process starts with an empty map. Bounding that would
 * need cross-process state, which is exactly the cache D28 keeps out of this
 * task; it arrives with T2.13.
 */
export class ModelTestRateLimiter {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly windowMs: number = MODEL_TEST_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Records an attempt and says whether it may proceed. `retryAfterSeconds` is
   * rounded UP so a refusal never tells the caller to come back too early.
   */
  take(caller: string, alias: string): { allowed: true } | { allowed: false; retryAfter: number } {
    // `\x00` written as an escape, never as a literal NUL: ripgrep skips a
    // file containing one, which reads as "this symbol has no callers".
    const key = `${caller}\x00${alias}`;
    const now = this.now();
    const previous = this.last.get(key);
    if (previous !== undefined) {
      const elapsed = now - previous;
      if (elapsed < this.windowMs) {
        return { allowed: false, retryAfter: Math.ceil((this.windowMs - elapsed) / 1000) };
      }
    }
    this.last.set(key, now);
    return { allowed: true };
  }

  /** Drop every record. For tests and for a caller that wants a clean slate. */
  reset(): void {
    this.last.clear();
  }
}

/** The limiter both front doors share when none is injected. */
export const modelTestRateLimiter = new ModelTestRateLimiter();

// ---------------------------------------------------------------------------
// Provider-entry resolution
// ---------------------------------------------------------------------------

/** One addressable provider entry: the key a registry alias names, and the entry itself. */
export interface ProviderEntryRef {
  key: string;
  entry: ProviderChainEntry;
}

/**
 * Every provider entry this config exposes, in chain order.
 *
 * When the file carries no `providers:` chain, the top-level
 * `provider`/`apiKey`/`model`/… IS chain index 0 (D2) — a single-provider
 * deployment can name it from the registry, and without this it would have no
 * representable entry at all.
 */
export function providerEntries(config: EthosConfig): ProviderEntryRef[] {
  const chain = config.providers ?? [];
  if (chain.length > 0) {
    return chain.map((entry, index) => ({ key: deriveProviderKey(entry, index), entry }));
  }
  if (!config.provider) return [];
  const top: ProviderChainEntry = {
    provider: config.provider,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
    ...(config.region ? { region: config.region } : {}),
    ...(config.awsProfile ? { awsProfile: config.awsProfile } : {}),
  };
  return [{ key: deriveProviderKey(top, 0), entry: top }];
}

/**
 * The entry a registry alias's `provider` key names, or `null`.
 *
 * An explicit `providers.<n>.id` wins over a positional `deriveProviderKey`
 * default, so an entry that deliberately claims a name is never shadowed by
 * another entry's derived one (D24).
 */
export function findProviderEntry(
  config: EthosConfig,
  providerKey: string,
): ProviderEntryRef | null {
  const entries = providerEntries(config);
  return (
    entries.find((e) => e.entry.id === providerKey) ??
    entries.find((e) => e.key === providerKey) ??
    null
  );
}

/**
 * One representative alias per provider ENTRY the registry references — what
 * `--all` tests.
 *
 * The credential belongs to the entry, not the alias (D2/D18), so six aliases
 * on one key are ONE check. The representative is the alphabetically first
 * alias in the group, so the sweep is deterministic across runs.
 */
export function providerEntryProbes(
  registry: ModelRegistry | undefined,
): Array<{ providerKey: string; alias: string; aliases: string[] }> {
  const grouped = new Map<string, string[]>();
  for (const entry of Object.values(registry?.entries ?? {})) {
    const group = grouped.get(entry.provider) ?? [];
    group.push(entry.alias);
    grouped.set(entry.provider, group);
  }
  const out: Array<{ providerKey: string; alias: string; aliases: string[] }> = [];
  for (const [providerKey, aliases] of [...grouped.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    const sorted = [...aliases].sort();
    const alias = sorted[0];
    if (alias === undefined) continue;
    out.push({ providerKey, alias, aliases: sorted });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The test itself
// ---------------------------------------------------------------------------

function unconfigured(alias: string, reason: string, fix?: string): ModelTestOutcome {
  return { state: 'unconfigured', alias, reason, ...(fix ? { fix } : {}) };
}

/**
 * Probe the model one registry alias names, once.
 *
 * The ONE function behind `ethos models test` and `modelRegistry.test`. It
 * resolves alias → provider entry → that entry's credential (following any
 * `${secrets:…}` reference), runs a single one-token completion with a
 * {@link MODEL_TEST_TIMEOUT_MS} bound, and returns the outcome. It writes
 * nothing anywhere: there is no health cache until T2.13 (D28).
 */
export async function testModelAlias(request: ModelTestRequest): Promise<ModelTestOutcome> {
  const { alias, config, secrets, caller } = request;
  const limiter = request.limiter ?? modelTestRateLimiter;

  const registry = config.modelRegistry;
  const entry = registry?.entries[alias];
  if (!entry) {
    const configured = Object.keys(registry?.entries ?? {}).sort();
    return unconfigured(
      alias,
      configured.length === 0
        ? `No model registry is configured, so there is no alias "${alias}" to test.`
        : `No registry alias "${alias}". Configured aliases: ${configured.join(', ')}.`,
      configured.length === 0
        ? 'Add one with `modelRegistry.<alias>.provider` / `.modelId` in ~/.ethos/config.yaml.'
        : undefined,
    );
  }

  const provider = findProviderEntry(config, entry.provider);
  if (!provider) {
    const keys = providerEntries(config).map((e) => e.key);
    return unconfigured(
      alias,
      `Alias "${alias}" names provider entry "${entry.provider}", which this config does not have.` +
        (keys.length > 0 ? ` Configured entries: ${keys.join(', ')}.` : ''),
      'Set `providers.<n>.id` on the entry this alias should use.',
    );
  }

  let apiKey: string;
  try {
    apiKey = provider.entry.apiKey ? await resolveSecretRef(provider.entry.apiKey, secrets) : '';
  } catch (err) {
    return unconfigured(
      alias,
      `The credential for provider entry "${provider.key}" could not be resolved: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // The rate limit is taken AFTER the configuration is known to be sound and
  // BEFORE anything billable happens: a refusal must never be spent on an
  // alias that could not have been probed anyway.
  const slot = limiter.take(caller, alias);
  if (!slot.allowed) {
    return { state: 'rate_limited', alias, retryAfterSeconds: slot.retryAfter };
  }

  const probe = request.probe ?? probeProvider;
  const probeConfig: ProbeProviderConfig = {
    provider: provider.entry.provider,
    model: entry.modelId,
    apiKey,
    timeoutMs: request.timeoutMs ?? MODEL_TEST_TIMEOUT_MS,
    ...(provider.entry.baseUrl ? { baseUrl: provider.entry.baseUrl } : {}),
    ...(provider.entry.apiVersion ? { apiVersion: provider.entry.apiVersion } : {}),
  };

  const outcome = await probe(probeConfig);
  const identity = {
    alias,
    providerKey: provider.key,
    provider: provider.entry.provider,
    modelId: entry.modelId,
  };
  if (outcome.ok) {
    // Carried ONLY when it differs from what was asked for (D19). The rule
    // lives here rather than in each renderer so the CLI, the RPC and T2.8's
    // button cannot disagree about when "responded as …" is worth a line —
    // showing the same id twice is noise, and a surface that has the field can
    // always find a reason to print it.
    const echoed =
      outcome.echoedModel && outcome.echoedModel !== entry.modelId
        ? outcome.echoedModel
        : undefined;
    return {
      state: 'ok',
      ...identity,
      latencyMs: outcome.latencyMs,
      ...(echoed ? { echoedModel: echoed } : {}),
    };
  }
  if (outcome.reason === 'rejected') {
    return {
      state: 'rejected',
      ...identity,
      error: outcome.error,
      fix: `Replace the key on provider entry "${provider.key}" — Settings → Models, or \`ethos setup auth\`.`,
    };
  }
  return { state: 'unreachable', ...identity, error: outcome.error };
}
