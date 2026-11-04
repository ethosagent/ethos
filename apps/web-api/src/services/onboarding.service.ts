import { totalmem } from 'node:os';
import { delimiter, join } from 'node:path';
import { validateUrl } from '@ethosagent/core';
import type { FilePersonalityRegistry } from '@ethosagent/personalities';
import type { SecretsResolver, Storage } from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import type {
  OnboardingStep,
  ProviderId,
  KeylessCandidate as WireKeylessCandidate,
} from '@ethosagent/web-contracts';
import {
  type FunnelTracker,
  isSafePathSegment,
  type KeylessPath,
  markPersonalityBorn,
} from '@ethosagent/wiring';
import {
  importExternalLogin,
  type KeylessCandidate,
  pickKeylessModel,
  probeKeyless,
} from '@ethosagent/wiring/keyless-probe';
import { getDefaultModel } from '@ethosagent/wiring/model-catalog';
import {
  OllamaPullError,
  type OllamaPullProgress,
  ollamaInstallPlan,
  pullOllamaModel,
} from '@ethosagent/wiring/ollama';
import { ORPCError } from '@orpc/server';
import type { ConfigRepository } from '../repositories/config.repository';

// Onboarding orchestration. Three RPCs:
//
//   • state             — derives the current step from disk: missing config
//                         → 'welcome'; provider+key set, no personality
//                         chosen yet → 'personality'; etc.
//   • validateProvider  — calls the provider's models endpoint with the
//                         supplied key. Returns the model list for the
//                         step-2 picker, or a normalised error string.
//   • complete          — writes provider/key/model/personality to
//                         ~/.ethos/config.yaml in one shot.
//
// All four supported providers go through one fetch helper — Anthropic +
// Ollama need slightly different request shapes; OpenRouter and OpenAI-
// compat use the OpenAI `GET /v1/models` envelope.

export interface OnboardingState {
  step: OnboardingStep;
  hasProvider: boolean;
  selectedPersonalityId: string | null;
}

export interface ValidateProviderInput {
  provider: ProviderId;
  apiKey: string;
  baseUrl?: string;
}

export interface ValidateProviderResult {
  ok: boolean;
  models: string[] | null;
  error: string | null;
  completionTested: boolean;
}

export interface CompleteInput {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  personalityId: string;
  /** Which keyless route produced the model; forwarded to the funnel. */
  keylessPath?: KeylessPath;
}

/** The machine facts `probe` reads. Injected in tests; defaults are the host's. */
export interface ProbeHost {
  platform: NodeJS.Platform;
  totalMemBytes: number;
  isRoot: boolean;
  /** Home directory holding `.codex` / `.hermes`. */
  home?: string;
}

export type PullStatus =
  | { state: 'idle' | 'done'; completedBytes: number; totalBytes: number; error: null }
  | { state: 'pulling'; completedBytes: number; totalBytes: number; error: null }
  | { state: 'error'; completedBytes: number; totalBytes: number; error: string };

const OLLAMA_ORIGIN = 'http://127.0.0.1:11434';
const GIB = 1024 ** 3;
const RUNTIME_PING_MS = 2_500;

export interface OnboardingServiceOptions {
  config: ConfigRepository;
  personalities: FilePersonalityRegistry;
  /** Secret store — used to check Codex OAuth tokens during validation. */
  secrets: SecretsResolver;
  /** Inject for tests. Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  /** Fired after `complete()` durably writes config.yaml. Fire-and-forget —
   *  exceptions are swallowed so a callback failure can't fail the RPC. */
  onSetupComplete?: () => void;
  /** Funnel stamps (plan keyless-first-run §6.2): `state()` stamps first
   *  launch, `complete()` records setup with the keyless path. Optional and
   *  fail-open — a stamp failure never fails the RPC. */
  funnel?: Pick<FunnelTracker, 'recordFirstLaunch' | 'recordSetupCompleted'>;
  /** Machine facts for `probe`. Defaults to the host process. */
  probeHost?: () => ProbeHost;
  /** Storage + data dir: `probe`'s PATH lookup for `brew`, and
   *  `namePersonality`'s birth marker. */
  storage?: Storage;
  dataDir?: string;
  /** Inject for tests. Defaults to wiring's `pullOllamaModel`. */
  pullFn?: typeof pullOllamaModel;
}

/** Mirrors `XAI_BASE_URL` in `@ethosagent/llm-xai`. Inlined rather than
 *  imported so validation keeps no runtime dep on the provider package —
 *  every other provider's endpoint is a literal here too. */
const XAI_BASE_URL = 'https://api.x.ai/v1';

const MODELS_TIMEOUT_MS = 8_000;
const COMPLETION_TIMEOUT_MS = 10_000;

/**
 * UBP-038 — the output cap the completion probe sends. OpenAI's reasoning
 * models (o-series, gpt-5.x — the catalog default) refuse `max_tokens` on Chat
 * Completions, and a cap of 1 would starve one that spends tokens reasoning
 * before it answers, so api.openai.com and a bare reasoning-family model id get
 * `max_completion_tokens: 16`. Everything else keeps `max_tokens: 1`. The rule
 * is copied from `outputCapParam` / `isOpenAiReasoningModelId` in
 * extensions/llm-openai-compat/src/transport.ts (an app does not import a
 * provider extension); change both together. Pinned by
 * `onboarding-completion.test.ts`.
 */
export function probeOutputCap(
  baseUrl: string,
  model: string,
): { max_tokens: number } | { max_completion_tokens: number } {
  let host = '';
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    // Not a URL: fall through to the model-id rule.
  }
  const reasoningId = /^(?:o\d+|gpt-5)(?:[-.]|$)/i.test(model);
  return host === 'api.openai.com' || reasoningId
    ? { max_completion_tokens: 16 }
    : { max_tokens: 1 };
}

export class OnboardingService {
  private readonly fetchFn: typeof fetch;
  private firstLaunchStamped = false;
  /** One pull at a time per process (plan §7). In-memory only. */
  private pull: PullStatus = { state: 'idle', completedBytes: 0, totalBytes: 0, error: null };
  private readonly pullDigests = new Map<string, { total: number; completed: number }>();

  constructor(private readonly opts: OnboardingServiceOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async state(): Promise<OnboardingState> {
    const raw = await this.opts.config.read();
    if (!raw && !this.firstLaunchStamped && this.opts.funnel) {
      this.firstLaunchStamped = true;
      // Earliest-wins is the tracker's job (funnel.test.ts "firstLaunchAt is
      // earliest-wins across two trackers"); this only has to call it.
      await this.opts.funnel.recordFirstLaunch().catch(() => {});
    }
    const hasProvider = !!(raw?.provider && (raw.apiKey || raw.provider === 'codex'));
    const personalityId = raw?.personality ?? null;

    if (!raw) return { step: 'welcome', hasProvider: false, selectedPersonalityId: null };
    if (!hasProvider) return { step: 'provider', hasProvider: false, selectedPersonalityId: null };
    if (!personalityId) return { step: 'personality', hasProvider, selectedPersonalityId: null };
    // Provider + personality both set → done. Front-end may still show the
    // "first turn" magic moment but that's a UI concern, not a config gate.
    return { step: 'done', hasProvider, selectedPersonalityId: personalityId };
  }

  async validateProvider(input: ValidateProviderInput): Promise<ValidateProviderResult> {
    // Codex uses device auth — check tokens exist, then ask the account which
    // models it can use. `discoverModels` falls back to the static roster on
    // any failure, so the picker is never empty.
    if (input.provider === 'codex') {
      const { CodexTokenStore, discoverModels } = await import('@ethosagent/llm-codex');
      const store = new CodexTokenStore(this.opts.secrets);
      const tokens = await store.load();
      if (!tokens) {
        return {
          ok: false,
          models: null,
          error: 'Codex not authorized — complete device auth first.',
          completionTested: false,
        };
      }
      const { models } = await discoverModels(tokens.accessToken, this.fetchFn);
      return { ok: true, models, error: null, completionTested: false };
    }

    try {
      const models = await this.fetchModels(input);
      if (input.provider === 'ollama') {
        return { ok: true, models, error: null, completionTested: false };
      }
      const chatModel = this.pickChatModel(input.provider, models);
      if (!chatModel) {
        return { ok: true, models, error: null, completionTested: false };
      }
      try {
        await this.testCompletion(input, chatModel);
        return { ok: true, models, error: null, completionTested: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isBillingError = message.includes('no credits');
        if (isBillingError) {
          return { ok: false, models, error: message, completionTested: false };
        }
        return { ok: true, models, error: null, completionTested: false };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, models: null, error: message, completionTested: false };
    }
  }

  async complete(input: CompleteInput): Promise<void> {
    if (!this.opts.personalities.get(input.personalityId)) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `Personality "${input.personalityId}" not found`,
        action: 'Pick from the list returned by `personalities.list`.',
      });
    }
    await this.opts.config.update({
      provider: input.provider,
      model: input.model,
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      personality: input.personalityId,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    });
    if (this.opts.funnel) {
      await this.opts.funnel
        .recordSetupCompleted({
          provider: input.provider,
          channels: [],
          wizardPath: 'web',
          ...(input.keylessPath ? { keylessPath: input.keylessPath } : {}),
        })
        .catch(() => {});
    }
    try {
      this.opts.onSetupComplete?.();
    } catch {
      // Fire-and-forget — a callback failure must not fail onboarding.
    }
  }

  // ---------------------------------------------------------------------------
  // Keyless first run (plan keyless-first-run §7)
  //
  // Every method below refuses once onboarding is done: `refuseIfConfigured`.
  // web-api NEVER spawns an installer (D11): `probe` returns command TEXT only.
  // Pinned by onboarding-keyless.test.ts ("the service module spawns nothing").
  // ---------------------------------------------------------------------------

  private async refuseIfConfigured(): Promise<void> {
    if ((await this.state()).step === 'done') {
      throw new ORPCError('ALREADY_CONFIGURED', {
        status: 409,
        message: 'Onboarding is already complete.',
      });
    }
  }

  async probe() {
    await this.refuseIfConfigured();
    const host = this.opts.probeHost?.() ?? defaultProbeHost();
    const hasBrew = await this.hasBrewOnPath();
    const installPlan = ollamaInstallPlan(host.platform, { hasBrew, isRoot: host.isRoot });
    const result = await probeKeyless({
      secrets: this.opts.secrets,
      platform: host.platform,
      totalMemBytes: host.totalMemBytes,
      isRoot: host.isRoot,
      fetchImpl: this.fetchFn,
      hasBrew,
      installPlan,
      ...(host.home ? { home: host.home } : {}),
    });
    const pick = pickKeylessModel(host.totalMemBytes);
    return {
      candidates: result.candidates.map(toWireCandidate),
      recommended: result.recommended,
      machine: {
        totalMemGiB: Math.round((host.totalMemBytes / GIB) * 10) / 10,
        pick: { modelId: pick.modelId, approxDownloadGb: pick.approxDownloadGb },
      },
      install: {
        os: installPlan.os,
        command: installPlan.command,
        notes: installPlan.notes,
        downloadUrl: installPlan.downloadUrl,
      },
    };
  }

  /** `brew` on PATH, through Storage. A lookup only, no process is spawned. */
  private async hasBrewOnPath(): Promise<boolean> {
    const storage = this.opts.storage;
    if (!storage) return false;
    const dirs = (process.env.PATH ?? '').split(delimiter);
    for (const dir of dirs) {
      if (!dir) continue;
      if (await storage.exists(join(dir, 'brew')).catch(() => false)) return true;
    }
    return false;
  }

  async importCodexLogin(input: { source: 'codex-cli' | 'hermes' }) {
    await this.refuseIfConfigured();
    const home = this.opts.probeHost?.().home;
    const imported = await importExternalLogin({
      secrets: this.opts.secrets,
      source: input.source,
      ...(home ? { home } : {}),
    });
    if (!imported.ok) return { ok: false as const, code: imported.reason };
    // The tokens are in the vault now; `validateProvider`'s codex branch reads
    // them there and asks the account for its models. Only model ids leave.
    const checked = await this.validateProvider({ provider: 'codex', apiKey: '' });
    if (!checked.ok || !checked.models)
      return { ok: false as const, code: 'invalid_shape' as const };
    return { ok: true as const, models: checked.models };
  }

  async pullModel(input: { model: string }) {
    await this.refuseIfConfigured();
    if (this.pull.state === 'pulling') {
      throw new ORPCError('PULL_IN_PROGRESS', {
        status: 409,
        message: 'A model download is already running.',
      });
    }
    if (!(await this.localRuntimeAnswers())) {
      throw new ORPCError('LOCAL_RUNTIME_UNREACHABLE', {
        status: 503,
        message: 'Ollama is not answering on 127.0.0.1:11434.',
      });
    }
    this.pullDigests.clear();
    this.pull = { state: 'pulling', completedBytes: 0, totalBytes: 0, error: null };
    const run = this.opts.pullFn ?? pullOllamaModel;
    void run({
      baseUrl: `${OLLAMA_ORIGIN}/v1`,
      model: input.model,
      fetchImpl: this.fetchFn,
      onProgress: (p) => this.recordPullProgress(p),
    }).then(
      () => {
        this.pull = { ...this.totals(), state: 'done', error: null };
      },
      (err: unknown) => {
        // Only Ollama's own status text is surfaced; anything else is generic.
        const message = err instanceof OllamaPullError ? err.message : 'The model download failed.';
        this.pull = { ...this.totals(), state: 'error', error: message };
      },
    );
    return { ok: true as const };
  }

  pullStatus(): PullStatus {
    if (this.pull.state === 'pulling') {
      return { state: 'pulling', ...this.totals(), error: null };
    }
    return this.pull;
  }

  private recordPullProgress(p: OllamaPullProgress): void {
    if (p.digest !== undefined && p.total !== undefined) {
      this.pullDigests.set(p.digest, { total: p.total, completed: p.completed ?? 0 });
    }
  }

  private totals(): { completedBytes: number; totalBytes: number } {
    let completedBytes = 0;
    let totalBytes = 0;
    for (const d of this.pullDigests.values()) {
      completedBytes += Math.min(d.completed, d.total);
      totalBytes += d.total;
    }
    return { completedBytes, totalBytes };
  }

  private async localRuntimeAnswers(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${OLLAMA_ORIGIN}/api/version`, {
        signal: AbortSignal.timeout(RUNTIME_PING_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async namePersonality(input: { sourceId: string; name: string }) {
    await this.refuseIfConfigured();
    const { storage, dataDir } = this.opts;
    if (!storage || !dataDir) {
      throw new EthosError({
        code: 'INTERNAL',
        cause: 'Onboarding was built without storage; it cannot create a personality.',
        action: 'Construct OnboardingService with storage and dataDir.',
      });
    }
    const id = input.name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!isSafePathSegment(id)) {
      throw new ORPCError('BAD_REQUEST', {
        status: 400,
        message: 'That name cannot be used as an agent id.',
      });
    }
    if (!this.opts.personalities.get(input.sourceId)) {
      throw new ORPCError('PERSONALITY_NOT_FOUND', {
        status: 404,
        message: `Personality "${input.sourceId}" not found.`,
      });
    }
    if (this.opts.personalities.get(id)) {
      throw new ORPCError('PERSONALITY_EXISTS', {
        status: 409,
        message: `Personality "${id}" already exists.`,
      });
    }
    try {
      await this.opts.personalities.duplicate(input.sourceId, id);
    } catch (err) {
      if (err instanceof EthosError && err.code === 'INVALID_INPUT') {
        throw new ORPCError('BAD_REQUEST', { status: 400, message: err.cause });
      }
      throw err;
    }
    // The web `duplicate` does not mark the copy born (plan §4.1); the ritual
    // and connectors both need it. The marker edits toolset.yaml, so reload.
    await markPersonalityBorn(storage, dataDir, id);
    await this.opts.personalities.loadFromDirectory(join(dataDir, 'personalities'));
    return { personalityId: id };
  }

  // ---------------------------------------------------------------------------
  // Chat model selection
  // ---------------------------------------------------------------------------

  private pickChatModel(provider: ProviderId, models: string[]): string | null {
    if (models.length === 0) return null;
    switch (provider) {
      case 'anthropic':
        return models.find((m) => m.startsWith('claude-')) ?? models[0] ?? null;
      case 'openai':
        return (
          models.find(
            (m) =>
              m.startsWith('gpt-') ||
              m.startsWith('o1-') ||
              m.startsWith('o3-') ||
              m.startsWith('o4-'),
          ) ??
          models[0] ??
          null
        );
      case 'codex': {
        // Prefer the catalog default when the account's live list carries it;
        // otherwise the first id the transport reported.
        const preferred = getDefaultModel('codex')?.modelId;
        return (preferred && models.includes(preferred) ? preferred : models[0]) ?? null;
      }
      default:
        return (
          models.find(
            (m) =>
              m.includes('chat') ||
              m.includes('gpt') ||
              m.includes('claude') ||
              m.includes('grok') ||
              m.includes('llama') ||
              m.includes('mistral') ||
              m.includes('gemma'),
          ) ??
          models[0] ??
          null
        );
    }
  }

  // ---------------------------------------------------------------------------
  // Provider model-list fetchers
  // ---------------------------------------------------------------------------

  private async fetchModels(input: ValidateProviderInput): Promise<string[]> {
    if (input.baseUrl) {
      validateUrl(input.baseUrl, {
        allowLocalhost: input.provider === 'ollama',
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
    try {
      switch (input.provider) {
        case 'anthropic':
          return await this.anthropicModels(input.apiKey, controller.signal);
        case 'ollama':
          return await this.ollamaModels(
            input.baseUrl ?? 'http://localhost:11434',
            controller.signal,
          );
        case 'openrouter':
          return await this.openAiCompatibleModels(
            input.baseUrl ?? 'https://openrouter.ai/api/v1',
            input.apiKey,
            controller.signal,
          );
        case 'openai':
          return await this.openAiCompatibleModels(
            input.baseUrl ?? 'https://api.openai.com/v1',
            input.apiKey,
            controller.signal,
          );
        case 'openai-compat':
          if (!input.baseUrl) throw new Error('baseUrl required for openai-compat');
          return await this.openAiCompatibleModels(input.baseUrl, input.apiKey, controller.signal);
        case 'azure':
          if (!input.baseUrl) throw new Error('baseUrl required for azure');
          return await this.openAiCompatibleModels(input.baseUrl, input.apiKey, controller.signal);
        case 'xai':
          // Hardcoded, not `input.baseUrl ?? default` like openrouter/openai:
          // the xai provider pins XAI_BASE_URL and ignores a configured
          // baseUrl, so honouring one here would validate a key against an
          // endpoint the agent will never actually call.
          return await this.openAiCompatibleModels(XAI_BASE_URL, input.apiKey, controller.signal);
        case 'codex':
          throw new Error('Codex uses device auth — call validateProvider directly');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async anthropicModels(apiKey: string, signal: AbortSignal): Promise<string[]> {
    const res = await this.fetchFn('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal,
    });
    if (!res.ok) throw new Error(`anthropic returned ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
  }

  private isAzureUrl(url: string): boolean {
    return url.includes('azure.com');
  }

  private async openAiCompatibleModels(
    baseUrl: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    const base = baseUrl.replace(/\/$/, '');
    if (this.isAzureUrl(base)) {
      return this.azureModels(base, apiKey, signal);
    }
    const url = `${base}/models`;
    validateUrl(url);
    const res = await this.fetchFn(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!res.ok) throw new Error(`${baseUrl} returned ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
  }

  private async azureModels(base: string, apiKey: string, signal: AbortSignal): Promise<string[]> {
    const url = `${base}/openai/models?api-version=2024-02-01`;
    validateUrl(url);
    const res = await this.fetchFn(url, {
      headers: { 'api-key': apiKey },
      signal,
    });
    if (!res.ok) throw new Error(`Azure returned ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
  }

  private async ollamaModels(baseUrl: string, signal: AbortSignal): Promise<string[]> {
    const url = `${baseUrl.replace(/\/$/, '')}/api/tags`;
    validateUrl(url, { allowLocalhost: true });
    const res = await this.fetchFn(url, { signal });
    if (!res.ok) throw new Error(`ollama returned ${res.status}`);
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((m) => m.name ?? '').filter(Boolean);
  }

  // ---------------------------------------------------------------------------
  // Completion test
  // ---------------------------------------------------------------------------

  private async testCompletion(input: ValidateProviderInput, model: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMPLETION_TIMEOUT_MS);
    try {
      switch (input.provider) {
        case 'ollama':
        case 'codex':
          return;
        case 'anthropic':
          await this.anthropicCompletion(input.apiKey, model, controller.signal);
          return;
        default:
          await this.openAiCompletion(
            this.resolveBaseUrl(input),
            input.apiKey,
            model,
            controller.signal,
          );
          return;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private resolveBaseUrl(input: ValidateProviderInput): string {
    switch (input.provider) {
      case 'openrouter':
        return input.baseUrl ?? 'https://openrouter.ai/api/v1';
      case 'openai':
        return input.baseUrl ?? 'https://api.openai.com/v1';
      case 'xai':
        // Pinned — see the `xai` case in `fetchModels`.
        return XAI_BASE_URL;
      case 'openai-compat':
      case 'azure':
      case 'codex':
        return input.baseUrl ?? '';
      default:
        return input.baseUrl ?? '';
    }
  }

  private async anthropicCompletion(
    apiKey: string,
    model: string,
    signal: AbortSignal,
  ): Promise<void> {
    const res = await this.fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal,
    });
    if (!res.ok) {
      throw await this.translateCompletionError(res, 'anthropic');
    }
  }

  private async openAiCompletion(
    baseUrl: string,
    apiKey: string,
    model: string,
    signal: AbortSignal,
  ): Promise<void> {
    const base = baseUrl.replace(/\/$/, '');
    let url: string;
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    if (this.isAzureUrl(base)) {
      url = `${base}/openai/deployments/${model}/chat/completions?api-version=2024-08-01-preview`;
      headers['api-key'] = apiKey;
    } else {
      url = `${base}/chat/completions`;
      headers.authorization = `Bearer ${apiKey}`;
    }

    const res = await this.fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        ...probeOutputCap(base, model),
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal,
    });
    if (!res.ok) {
      throw await this.translateCompletionError(res, baseUrl);
    }
  }

  private async translateCompletionError(res: Response, provider: string): Promise<Error> {
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      /* ignore */
    }
    const lower = bodyText.toLowerCase();

    if (
      res.status === 402 ||
      lower.includes('insufficient_quota') ||
      lower.includes('billing') ||
      lower.includes('credit')
    ) {
      return new Error(
        "Your API key is valid but your account has no credits. Add credits at your provider's billing page.",
      );
    }

    if (
      res.status === 403 ||
      lower.includes('model_not_found') ||
      lower.includes('access_denied')
    ) {
      return new Error(
        'This model is not available on your plan. Try selecting a different model.',
      );
    }

    return new Error(
      `API key validated, but a test message failed: ${provider} returned ${res.status}. You may still proceed, but the agent may not respond.`,
    );
  }
}

function defaultProbeHost(): ProbeHost {
  return {
    platform: process.platform,
    totalMemBytes: totalmem(),
    isRoot: process.getuid?.() === 0,
  };
}

/** Wire shape: `external-login.path` is dropped (the server's home path never
 *  reaches the browser) and `install-offer` carries only its kind (the command
 *  text rides in the response's top-level `install`). Pinned by
 *  onboarding-keyless.test.ts ("path is omitted on the wire"). */
function toWireCandidate(c: KeylessCandidate): WireKeylessCandidate {
  switch (c.kind) {
    case 'external-login':
      return { kind: 'external-login', source: c.source, provider: c.provider };
    case 'install-offer':
      return { kind: 'install-offer' };
    case 'local':
      return {
        kind: 'local',
        runtime: c.runtime,
        provider: c.provider,
        baseUrl: c.baseUrl,
        models: c.models,
        ...(c.contextWindow !== undefined ? { contextWindow: c.contextWindow } : {}),
        ...(c.belowContextFloor !== undefined ? { belowContextFloor: c.belowContextFloor } : {}),
      };
    case 'ethos-login':
      return { kind: 'ethos-login', provider: c.provider };
    case 'paste-key':
      return { kind: 'paste-key' };
  }
}
