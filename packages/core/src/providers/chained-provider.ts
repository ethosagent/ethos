import type {
  CompletionChunk,
  CompletionOptions,
  FailoverReason,
  LLMProvider,
  Message,
  ProviderCapabilities,
  ToolDefinitionLite,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * The HTTP status an SDK error carries as a property — `status` (OpenAI SDK
 * `APIError`, codex's `ResponsesApiError`, Anthropic SDK) or `statusCode`.
 * Preferred over the message text, which can contain any digits at all.
 */
function structuredStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  for (const field of ['status', 'statusCode']) {
    const value: unknown = (err as Record<string, unknown>)[field];
    const n =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d{3}$/.test(value)
          ? Number(value)
          : undefined;
    if (n !== undefined && n >= 100 && n <= 599) return n;
  }
  return undefined;
}

export function classifyProviderError(err: unknown): FailoverReason {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const status = structuredStatus(err);
  // A structured status is authoritative. Without one, a status code counts
  // only as a whole token: `request id abc4290` is not a rate limit.
  const is = (code: number) =>
    status !== undefined ? status === code : new RegExp(`\\b${code}\\b`).test(msg);
  if (
    is(401) ||
    is(403) ||
    msg.includes('authentication') ||
    msg.includes('api key') ||
    msg.includes('unauthorized')
  )
    return 'auth';
  if (
    is(429) ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('too many requests')
  )
    return 'rate_limit';
  if (is(529) || is(503) || msg.includes('overloaded') || msg.includes('service unavailable'))
    return 'overloaded';
  if (
    msg.includes('context') &&
    (msg.includes('overflow') || msg.includes('too long') || msg.includes('too large'))
  )
    return 'context_overflow';
  if (msg.includes('content') && (msg.includes('filter') || msg.includes('policy')))
    return 'content_filter';
  if (
    is(404) ||
    msg.includes('model not found') ||
    msg.includes('model_not_found') ||
    msg.includes('no such model')
  )
    return 'model_not_found';
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout'))
    return 'timeout';
  if (
    msg.includes('network') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up')
  )
    return 'network';
  return 'unknown';
}

// Reasons that warrant trying the next provider in the chain.
const FAILOVER_REASONS = new Set<FailoverReason>([
  'rate_limit',
  'overloaded',
  'timeout',
  'network',
  'unknown',
  'model_not_found',
]);

function shouldFailover(reason: FailoverReason): boolean {
  return FAILOVER_REASONS.has(reason);
}

// A pinned call (D21) may never fail over, and `createLLMFromRegistry`
// (packages/wiring/src/index.ts) builds every hop of a 2+ hop chain with
// `maxRetries: 0` so SDK retries cannot hold a turn before failover. Together
// those left a pinned call failing on its first transient error, where the SDK
// used to retry twice. These restore that inside the chain, bounded so a pinned
// turn never stalls for a minute: up to 3 attempts, 500ms then 1500ms backoff
// (+ up to 25% jitter), an honoured `retry-after` capped at 10s per wait.
// Transient reasons only — `unknown` and `model_not_found` still fail over on an
// unpinned call, but retrying the same entry on them buys nothing.
const PINNED_MAX_ATTEMPTS = 3;
const PINNED_BASE_DELAY_MS = 500;
const PINNED_BACKOFF_FACTOR = 3;
const PINNED_JITTER_RATIO = 0.25;
const PINNED_MAX_WAIT_MS = 10_000;
const PINNED_RETRY_REASONS = new Set<FailoverReason>([
  'rate_limit',
  'overloaded',
  'timeout',
  'network',
]);

/** The wait before pinned retry number `retry` (1-based). */
function pinnedRetryDelayMs(retry: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, PINNED_MAX_WAIT_MS);
  const base = PINNED_BASE_DELAY_MS * PINNED_BACKOFF_FACTOR ** (retry - 1);
  return Math.min(base + Math.random() * base * PINNED_JITTER_RATIO, PINNED_MAX_WAIT_MS);
}

/**
 * The server's requested wait, read the way the Anthropic and OpenAI SDKs read
 * it (`retryRequest` in their `client.js`): their `APIError` carries the
 * response `headers`; `retry-after-ms` wins, then `retry-after` as seconds or
 * an HTTP date. `undefined` when the error carries neither.
 */
function retryAfterMs(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const headers: unknown = (err as Record<string, unknown>).headers;
  if (typeof headers !== 'object' || headers === null) return undefined;
  const read = (name: string): string | undefined => {
    const get: unknown = (headers as { get?: unknown }).get;
    const value: unknown =
      typeof get === 'function'
        ? get.call(headers, name)
        : (headers as Record<string, unknown>)[name];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };
  const ms = Number(read('retry-after-ms') ?? Number.NaN);
  if (Number.isFinite(ms)) return Math.max(0, ms);
  const after = read('retry-after');
  if (after === undefined) return undefined;
  const seconds = Number(after);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(after);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Resolves after `ms`, or rejects with the abort reason the moment `signal` fires. */
function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** How much of a vendor's error text a failover record and the final error keep. */
const MAX_ERROR_CHARS = 300;

/**
 * The vendor's own words, bounded and with anything key-shaped removed — the
 * text lands in an error a chat surface shows and in `observability.db`.
 */
export function boundedErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const status = structuredStatus(err);
  const text =
    status !== undefined && !new RegExp(`\\b${status}\\b`).test(raw)
      ? `HTTP ${status}: ${raw}`
      : raw;
  const redacted = text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(?:sk|pk|rk|gsk|xai)-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, '[redacted]')
    .replace(
      /((?:api[-_ ]?key|access[-_ ]?token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      '$1[redacted]',
    )
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return redacted.length > MAX_ERROR_CHARS ? `${redacted.slice(0, MAX_ERROR_CHARS)}…` : redacted;
}

// ---------------------------------------------------------------------------
// Provider entry keys
// ---------------------------------------------------------------------------

const ENTRY_KEYS = new WeakMap<LLMProvider, string>();

/**
 * Record which provider ENTRY (`providers.<n>.id`, or `deriveProviderKey`'s
 * positional default) this instance was built from. Wiring tags every
 * instance it builds in `createLLMFromRegistry`; `LLMProvider` itself has no
 * such field (it is a frozen contract) and an entry key is a deployment fact,
 * not a provider one.
 */
export function tagProviderEntry<P extends LLMProvider>(provider: P, key: string): P {
  ENTRY_KEYS.set(provider, key);
  return provider;
}

/** One provider entry a loop's LLM can reach, with the model it is configured to run. */
export interface ReachableProviderEntry {
  key: string;
  model: string;
}

/**
 * The provider entries `llm` serves: a chain's hops, or a tagged single
 * provider's own entry. `undefined` for an untagged provider — nothing names
 * its entry, so a caller has nothing to scope a model against.
 */
export function providerEntriesOf(llm: LLMProvider): ReachableProviderEntry[] | undefined {
  if (llm instanceof ChainedProvider) return llm.reachableEntries();
  const key = ENTRY_KEYS.get(llm);
  return key === undefined ? undefined : [{ key, model: llm.model }];
}

// ---------------------------------------------------------------------------
// ChainedProvider
// ---------------------------------------------------------------------------

interface EntryFailure {
  reason: FailoverReason;
  /** {@link boundedErrorMessage} of what the vendor said. */
  message: string;
}

interface ChainEntry {
  provider: LLMProvider;
  key: string;
  cooldownUntil: number;
  lastFailure?: EntryFailure;
}

interface AttemptFailure extends EntryFailure {
  entry: ChainEntry;
  /** The model this attempt asked for. */
  model: string;
  /** Set when the entry was cooling down at the start of the call and only tried last. */
  cooling?: { remainingMs: number; last?: EntryFailure };
  /** The wait the vendor asked for ({@link retryAfterMs}), when it named one. */
  retryAfterMs?: number;
}

/** One failed attempt, reported through {@link ChainedProviderOptions.onFailover}. */
export interface ChainFailoverEvent {
  entryKey: string;
  provider: string;
  model: string;
  reason: FailoverReason;
  message: string;
  /**
   * What the chain did next: tried the next ready entry, retried an entry that
   * was cooling down, retried a pinned call's own entry after a backoff, or
   * gave up and threw.
   */
  outcome: 'next-entry' | 'retry-cooling' | 'retry-pinned' | 'give-up';
  nextEntryKey?: string;
  /** The call named this entry and may not fail over (D21). */
  pinned: boolean;
}

export interface ChainedProviderOptions {
  /** Milliseconds to cool a provider down after a failover-eligible error. Default: 60000. */
  cooldownMs?: number;
  /**
   * Called once per failed attempt that the chain absorbs or gives up on. A
   * throwing callback is ignored — telemetry never breaks a completion. Wired
   * to observability in `createLLMFromRegistry` (packages/wiring).
   */
  onFailover?: (event: ChainFailoverEvent) => void;
}

/**
 * Wraps multiple LLMProviders with automatic failover.
 *
 * On a failover-eligible error (rate_limit, overloaded, timeout, network, unknown,
 * model_not_found) the failing provider is put on cooldown and the next provider
 * is tried. Non-retriable errors (auth, content_filter, context_overflow)
 * propagate immediately. Entries cooling down are not skipped for good: when every
 * ready entry has failed they are retried once, in chain order, in the same call —
 * a cooldown is a guess about the vendor and can be stale.
 *
 * The first emitted CompletionChunk (any variant) commits the attempt: a later error,
 * retryable or not, propagates and no other provider is started. Failover only happens
 * on errors thrown before the first chunk, and never once `options.abortSignal` has
 * fired. Enforced by the `yieldedAny` / `abortSignal.aborted` guard in `attempt`;
 * pinned by the "ChainedProvider stream commit (F03)" tests in
 * `packages/core/src/__tests__/chained-provider.test.ts`.
 *
 * `modelOverride` never reaches a hop it does not belong to (`optionsFor`):
 *   - scoped by `options.providerEntry` → only that entry receives it; with
 *     `pinned: true` no other entry is tried at all (D21) — instead a transient
 *     error (rate_limit, overloaded, timeout, network) before the first chunk
 *     retries that entry, up to 3 attempts with a bounded backoff
 *     (`PINNED_MAX_ATTEMPTS` and friends, above);
 *   - unscoped, naming a model some hop is configured with → it is that hop's
 *     own model, so every hop runs its own model;
 *   - unscoped, naming a model no hop is configured with → sent to every hop
 *     (nothing says which one serves it), and a `model_not_found` for it does
 *     not cool the hop down.
 *
 * Error codes:
 *   ALL_PROVIDERS_FAILED         — every entry was tried and failed with a failover-eligible error
 *   ALL_PROVIDERS_REJECT_MODEL   — every entry was tried and failed with model_not_found
 *   PINNED_PROVIDER_FAILED       — the one entry a pinned call names failed; nothing else was tried
 *   PROVIDER_ENTRY_NOT_IN_CHAIN  — `options.providerEntry` names no hop; nothing was tried
 */
export class ChainedProvider implements LLMProvider {
  private readonly entries: ChainEntry[];
  private readonly cooldownMs: number;
  private readonly onFailover: ((event: ChainFailoverEvent) => void) | undefined;

  constructor(providers: LLMProvider[], opts: ChainedProviderOptions = {}) {
    if (providers.length === 0) throw new Error('ChainedProvider requires at least one provider');
    this.entries = providers.map((provider, index) => ({
      provider,
      key: ENTRY_KEYS.get(provider) ?? (index === 0 ? provider.name : `${provider.name}-${index}`),
      cooldownUntil: 0,
    }));
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.onFailover = opts.onFailover;
  }

  get name(): string {
    return `chain(${this.entries.map((e) => e.provider.name).join(',')})`;
  }

  get model(): string {
    return this.activeEntry()?.provider.model ?? this.entries[0]?.provider.model ?? '';
  }

  get maxContextTokens(): number {
    return this.activeEntry()?.provider.maxContextTokens ?? 200_000;
  }

  get supportsCaching(): boolean {
    return this.activeEntry()?.provider.supportsCaching ?? false;
  }

  get supportsThinking(): boolean {
    return this.activeEntry()?.provider.supportsThinking ?? false;
  }

  get capabilities(): ProviderCapabilities | undefined {
    return this.activeEntry()?.provider.capabilities;
  }

  /** Every hop, in chain order, with the model it is configured to run. */
  reachableEntries(): ReachableProviderEntry[] {
    return this.entries.map((e) => ({ key: e.key, model: e.provider.model }));
  }

  async *complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    const scope = options.providerEntry;
    if (scope) {
      const target = this.entries.find((e) => e.key === scope.key);
      if (!target) {
        throw new Error(
          `PROVIDER_ENTRY_NOT_IN_CHAIN: provider entry "${scope.key}" is not a hop in ${this.name} ` +
            `(hops: ${this.entries.map((e) => e.key).join(', ')}). Nothing ran.`,
        );
      }
      if (scope.pinned) {
        for (let attempts = 1; ; attempts++) {
          // `attempt` rethrows once a chunk was yielded or the caller aborted,
          // so a retry here never splices two answers or outlives an abort.
          const failure = yield* this.attempt(target, messages, tools, options);
          if (!failure) return;
          const retry = attempts < PINNED_MAX_ATTEMPTS && PINNED_RETRY_REASONS.has(failure.reason);
          if (retry) {
            this.report(failure, 'retry-pinned', target.key, true);
            await sleepUnlessAborted(
              pinnedRetryDelayMs(attempts, failure.retryAfterMs),
              options.abortSignal,
            );
            continue;
          }
          this.report(failure, 'give-up', undefined, true);
          throw new Error(
            `PINNED_PROVIDER_FAILED: ${describeAttempt(failure)}. This call is pinned to provider ` +
              `entry "${target.key}", so no other provider was tried ` +
              `(${attempts} attempt${attempts === 1 ? '' : 's'} made).`,
          );
        }
      }
    }

    const now = Date.now();
    const cooling = new Map<ChainEntry, NonNullable<AttemptFailure['cooling']>>();
    for (const entry of this.entries) {
      if (entry.cooldownUntil > now) {
        cooling.set(entry, {
          remainingMs: entry.cooldownUntil - now,
          ...(entry.lastFailure ? { last: entry.lastFailure } : {}),
        });
      }
    }
    const order = [
      ...this.entries.filter((e) => !cooling.has(e)),
      ...this.entries.filter((e) => cooling.has(e)),
    ];

    const failures: AttemptFailure[] = [];
    for (const [i, entry] of order.entries()) {
      if (i > 0 && options.abortSignal?.aborted) {
        throw options.abortSignal.reason ?? new Error('aborted');
      }
      const failure = yield* this.attempt(entry, messages, tools, options);
      if (!failure) return;
      const wasCooling = cooling.get(entry);
      if (wasCooling) failure.cooling = wasCooling;
      failures.push(failure);
      const next = order[i + 1];
      this.report(
        failure,
        next === undefined ? 'give-up' : cooling.has(next) ? 'retry-cooling' : 'next-entry',
        next?.key,
        false,
      );
    }

    const tried = failures.map(describeAttempt).join('; ');
    if (failures.every((f) => f.reason === 'model_not_found')) {
      throw new Error(
        `ALL_PROVIDERS_REJECT_MODEL: no provider in the chain accepted the requested model. Tried: ${tried}`,
      );
    }
    throw new Error(
      `ALL_PROVIDERS_FAILED: all ${failures.length} providers in the chain were tried and failed. Tried: ${tried}`,
    );
  }

  async countTokens(messages: Message[]): Promise<number> {
    const entry = this.activeEntry();
    if (!entry) return 0;
    return entry.provider.countTokens(messages);
  }

  /**
   * One attempt against one entry. Returns `null` on success, the failure when
   * the chain may move on, and rethrows anything it may not absorb.
   */
  private async *attempt(
    entry: ChainEntry,
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncGenerator<CompletionChunk, AttemptFailure | null> {
    const entryOptions = this.optionsFor(entry, options);
    let yieldedAny = false;
    try {
      for await (const chunk of entry.provider.complete(messages, tools, entryOptions)) {
        yieldedAny = true;
        yield chunk;
      }
      entry.cooldownUntil = 0;
      return null;
    } catch (err) {
      // The consumer folds every chunk into one assistant turn, so a second
      // attempt after any chunk would splice two answers together. And an
      // abort is the caller stopping the turn, not a provider fault — no
      // next attempt, no cooldown.
      if (yieldedAny || options.abortSignal?.aborted) throw err;

      const reason = classifyProviderError(err);
      if (!shouldFailover(reason)) throw err;

      const failure: AttemptFailure = {
        entry,
        reason,
        message: boundedErrorMessage(err),
        model: entryOptions.modelOverride ?? entry.provider.model,
      };
      const wait = retryAfterMs(err);
      if (wait !== undefined) failure.retryAfterMs = wait;
      // A hop rejecting a model it was never configured with says nothing about
      // the hop's health — cooling it would take it away from every other call.
      if (!(reason === 'model_not_found' && entryOptions.modelOverride !== undefined)) {
        entry.cooldownUntil = Date.now() + this.cooldownMs;
      }
      entry.lastFailure = { reason: failure.reason, message: failure.message };
      return failure;
    }
  }

  /** `options` as `entry` receives it — see the class doc for the `modelOverride` rules. */
  private optionsFor(entry: ChainEntry, options: CompletionOptions): CompletionOptions {
    const { providerEntry, modelOverride, ...rest } = options;
    if (modelOverride === undefined || modelOverride === entry.provider.model) return rest;
    if (providerEntry) return providerEntry.key === entry.key ? { ...rest, modelOverride } : rest;
    return this.entries.some((e) => e.provider.model === modelOverride)
      ? rest
      : { ...rest, modelOverride };
  }

  private report(
    failure: AttemptFailure,
    outcome: ChainFailoverEvent['outcome'],
    nextEntryKey: string | undefined,
    pinned: boolean,
  ): void {
    if (!this.onFailover) return;
    try {
      this.onFailover({
        entryKey: failure.entry.key,
        provider: failure.entry.provider.name,
        model: failure.model,
        reason: failure.reason,
        message: failure.message,
        outcome,
        ...(nextEntryKey !== undefined ? { nextEntryKey } : {}),
        pinned,
      });
    } catch {
      // Telemetry never breaks a completion.
    }
  }

  // Returns the first non-cooled provider, or undefined if all are cooled.
  private activeEntry(): ChainEntry | undefined {
    const now = Date.now();
    return this.entries.find((e) => e.cooldownUntil <= now);
  }
}

function describeAttempt(f: AttemptFailure): string {
  const head = `${f.entry.key} (${f.entry.provider.name}/${f.model}): ${f.reason} — "${f.message}"`;
  if (!f.cooling) return head;
  const seconds = Math.ceil(f.cooling.remainingMs / 1000);
  const last = f.cooling.last
    ? ` after ${f.cooling.last.reason} — "${f.cooling.last.message}"`
    : '';
  return `${head} [was cooling down, ${seconds}s left${last}; retried anyway]`;
}
