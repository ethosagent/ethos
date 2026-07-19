import { EthosError, type SecretsResolver } from '@ethosagent/types';
import type { ConfigRepository, RawProviderEntry } from '../repositories/config.repository';

// Read/update the parts of `~/.ethos/config.yaml` the web UI exposes. The
// raw API key NEVER leaves this layer — `get` returns a redacted preview
// (`sk-…abc1`) so the UI can show "which key is active" without leaking
// it. `update` accepts a fresh key but does not echo it back.

export interface ConfigGetResult {
  provider: string;
  model: string;
  apiKeyPreview: string;
  baseUrl: string | null;
  personality: string;
  memory: 'markdown' | 'vector';
  modelRouting: Record<string, string>;
  skin: string;
  providers: Array<{
    provider: string;
    model: string | null;
    apiKeyPreview: string;
    baseUrl: string | null;
  }>;
  approvalMode: 'manual' | 'smart' | 'off';
  verbosity: 'concise' | 'balanced' | 'verbose';
  debugMode: boolean;
  contextLayering: boolean;
  debugPanelEnabled: boolean;
  debugPanelModel: string | null;
  adminEnabled: boolean;
  streamingEdits: 'off' | 'dms' | 'all';
  autoCompact: boolean;
  memoryConsolidationEnabled: boolean;
  memoryCaptureEnabled: boolean;
  memoryCaptureModel: string | null;
  memoryNotices: boolean;
  voiceChime: boolean;
  voiceProvider: string | null;
  voiceApiKeyPreview: string | null;
  voiceBaseUrl: string | null;
  voiceModel: string | null;
  voiceTtsProvider: string | null;
  voiceTtsApiKeyPreview: string | null;
  voiceTtsVoice: string | null;
  voiceTtsBaseUrl: string | null;
  voiceTtsModel: string | null;
}

export interface ConfigUpdateInput {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  personality?: string;
  memory?: 'markdown' | 'vector';
  modelRouting?: Record<string, string>;
  skin?: string;
  providers?: Array<{
    provider: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  }>;
  approvalMode?: 'manual' | 'smart' | 'off';
  verbosity?: 'concise' | 'balanced' | 'verbose';
  debugMode?: boolean;
  contextLayering?: boolean;
  debugPanelEnabled?: boolean;
  debugPanelModel?: string | null;
  adminEnabled?: boolean;
  streamingEdits?: 'off' | 'dms' | 'all';
  autoCompact?: boolean;
  memoryConsolidationEnabled?: boolean;
  memoryCaptureEnabled?: boolean;
  memoryCaptureModel?: string;
  memoryNotices?: boolean;
  voiceChime?: boolean;
  voiceProvider?: string;
  voiceApiKey?: string;
  voiceBaseUrl?: string;
  voiceModel?: string;
  voiceTtsProvider?: string;
  voiceTtsApiKey?: string;
  voiceTtsVoice?: string;
  voiceTtsBaseUrl?: string;
  voiceTtsModel?: string;
}

export interface ConfigServiceOptions {
  config: ConfigRepository;
  /** Resolves `${secrets:ref}` indirection in stored API keys (admin
   *  provider health checks). Optional — when omitted, secret-ref keys
   *  resolve to '' so checks fail honestly instead of probing with the
   *  literal reference string. */
  secrets?: SecretsResolver;
}

export class ConfigService {
  constructor(private readonly opts: ConfigServiceOptions) {}

  async get(): Promise<ConfigGetResult> {
    const raw = await this.opts.config.read();
    if (!raw?.provider) {
      throw new EthosError({
        code: 'CONFIG_MISSING',
        cause: 'Config not found at ~/.ethos/config.yaml',
        action: 'Run onboarding from the web UI or `ethos setup` from the CLI.',
      });
    }
    return {
      provider: raw.provider ?? '',
      model: raw.model ?? '',
      apiKeyPreview: redactKey(raw.apiKey),
      baseUrl: raw.baseUrl ?? null,
      personality: raw.personality ?? 'researcher',
      memory: raw.memory ?? 'markdown',
      modelRouting: raw.modelRouting,
      skin: raw.skin ?? 'default',
      providers: raw.providers.map((p) => ({
        provider: p.provider,
        model: p.model ?? null,
        apiKeyPreview: redactKey(p.apiKey),
        baseUrl: p.baseUrl ?? null,
      })),
      approvalMode: raw.approvalMode ?? 'manual',
      verbosity: raw.verbosity ?? 'balanced',
      debugMode: raw.debugMode ?? false,
      contextLayering: raw.contextLayering ?? false,
      debugPanelEnabled: raw.debugPanelEnabled ?? false,
      debugPanelModel: raw.debugPanelModel ?? null,
      adminEnabled: raw.passthrough['admin.enabled'] === 'true',
      streamingEdits: parseStreamingEdits(raw.passthrough['display.streaming_edits']),
      autoCompact: raw.passthrough['compaction.autoCompact'] === 'true',
      memoryConsolidationEnabled: raw.passthrough['memoryConsolidation.enabled'] === 'true',
      memoryCaptureEnabled: raw.passthrough['memoryCapture.enabled'] === 'true',
      memoryCaptureModel: raw.passthrough['memoryCapture.model'] || null,
      memoryNotices: raw.passthrough['display.memory_notices'] === 'true',
      // Default ON — the talk-mode chime plays unless explicitly disabled.
      voiceChime: raw.passthrough['display.voice_chime'] !== 'false',
      voiceProvider: raw.voiceProvider ?? null,
      voiceApiKeyPreview: raw.voiceApiKey ? redactKey(raw.voiceApiKey) : null,
      voiceBaseUrl: raw.voiceBaseUrl ?? null,
      voiceModel: raw.voiceModel ?? null,
      voiceTtsProvider: raw.voiceTtsProvider ?? null,
      voiceTtsApiKeyPreview: raw.voiceTtsApiKey ? redactKey(raw.voiceTtsApiKey) : null,
      voiceTtsVoice: raw.voiceTtsVoice ?? null,
      voiceTtsBaseUrl: raw.voiceTtsBaseUrl ?? null,
      voiceTtsModel: raw.voiceTtsModel ?? null,
    };
  }

  /**
   * Whether the web admin panel is enabled. Gated by `admin.enabled: true`
   * in ~/.ethos/config.yaml — default false; admin access must be enabled
   * explicitly. Missing config counts as disabled.
   */
  async adminEnabled(): Promise<boolean> {
    const raw = await this.opts.config.read();
    return raw?.passthrough['admin.enabled'] === 'true';
  }

  /**
   * Resolve the stored credentials for a provider so admin health checks
   * probe with the real key. The raw key still never crosses the RPC
   * boundary — it travels provider-ward only. Prefers the provider-chain
   * entry; falls back to the primary provider fields. Returns null when
   * the provider isn't configured.
   */
  async resolveProviderCredentials(
    provider: string,
  ): Promise<{ apiKey: string; baseUrl?: string } | null> {
    const raw = await this.opts.config.read();
    if (!raw) return null;
    const entry = raw.providers.find((p) => p.provider === provider);
    if (entry) {
      return {
        apiKey: await this.resolveSecretRefs(entry.apiKey ?? ''),
        ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      };
    }
    if (raw.provider === provider) {
      return {
        apiKey: await this.resolveSecretRefs(raw.apiKey ?? ''),
        ...(raw.baseUrl ? { baseUrl: raw.baseUrl } : {}),
      };
    }
    return null;
  }

  /** Substitute `${secrets:ref}` references via the resolver. An
   *  unresolvable reference (or no resolver) yields '' — the caller's
   *  health check then fails honestly rather than probing with a
   *  literal `${secrets:...}` string. */
  private async resolveSecretRefs(value: string): Promise<string> {
    const matches = [...value.matchAll(SECRETS_REF_RE)];
    if (matches.length === 0) return value;
    if (!this.opts.secrets) return '';
    let resolved = value;
    for (const m of matches) {
      const ref = m[1];
      if (!ref) continue;
      const secret = await this.opts.secrets.get(ref);
      if (secret === null) return '';
      resolved = resolved.replace(m[0], () => secret);
    }
    return resolved;
  }

  async update(patch: ConfigUpdateInput): Promise<void> {
    // Empty-string apiKey would erase the existing key. Treat as no-op.
    const cleaned: typeof patch = { ...patch };
    if (cleaned.apiKey !== undefined && cleaned.apiKey === '') delete cleaned.apiKey;

    // These behavior flags are flat config keys (`admin.enabled`,
    // `display.streaming_edits`, `compaction.autoCompact`, …), not typed fields
    // on the repository's RawConfig. Translate each into a passthrough write and
    // strip it from the patch so it doesn't reach the repository. Passthrough
    // merges add/overwrite only, so writing `memoryConsolidation.enabled` here
    // preserves the sibling `memoryConsolidation.*` decay-tuning keys.
    const passthroughPatch: Record<string, string> = {};
    if (patch.adminEnabled !== undefined) {
      passthroughPatch['admin.enabled'] = patch.adminEnabled ? 'true' : 'false';
    }
    if (patch.streamingEdits !== undefined) {
      passthroughPatch['display.streaming_edits'] = patch.streamingEdits;
    }
    if (patch.autoCompact !== undefined) {
      passthroughPatch['compaction.autoCompact'] = patch.autoCompact ? 'true' : 'false';
    }
    if (patch.memoryConsolidationEnabled !== undefined) {
      passthroughPatch['memoryConsolidation.enabled'] = patch.memoryConsolidationEnabled
        ? 'true'
        : 'false';
    }
    if (patch.memoryCaptureEnabled !== undefined) {
      passthroughPatch['memoryCapture.enabled'] = patch.memoryCaptureEnabled ? 'true' : 'false';
    }
    if (patch.memoryCaptureModel !== undefined) {
      passthroughPatch['memoryCapture.model'] = patch.memoryCaptureModel;
    }
    if (patch.memoryNotices !== undefined) {
      passthroughPatch['display.memory_notices'] = patch.memoryNotices ? 'true' : 'false';
    }
    if (patch.voiceChime !== undefined) {
      passthroughPatch['display.voice_chime'] = patch.voiceChime ? 'true' : 'false';
    }
    const passthrough = Object.keys(passthroughPatch).length > 0 ? passthroughPatch : undefined;
    delete cleaned.adminEnabled;
    delete cleaned.streamingEdits;
    delete cleaned.autoCompact;
    delete cleaned.memoryConsolidationEnabled;
    delete cleaned.memoryCaptureEnabled;
    delete cleaned.memoryCaptureModel;
    delete cleaned.memoryNotices;
    delete cleaned.voiceChime;

    // Convert providers to repository format when present.
    let repoProviders: RawProviderEntry[] | undefined;
    if (cleaned.providers) {
      repoProviders = cleaned.providers.map((p) => {
        const entry: RawProviderEntry = { provider: p.provider };
        if (p.model) entry.model = p.model;
        if (p.apiKey) entry.apiKey = p.apiKey;
        if (p.baseUrl) entry.baseUrl = p.baseUrl;
        return entry;
      });
    }

    await this.opts.config.update({
      ...cleaned,
      ...(repoProviders !== undefined ? { providers: repoProviders } : {}),
      ...(passthrough !== undefined ? { passthrough } : {}),
      ...(patch.voiceProvider !== undefined
        ? { voiceProvider: patch.voiceProvider || undefined }
        : {}),
      ...(patch.voiceApiKey !== undefined ? { voiceApiKey: patch.voiceApiKey || undefined } : {}),
      ...(patch.voiceBaseUrl !== undefined
        ? { voiceBaseUrl: patch.voiceBaseUrl || undefined }
        : {}),
      ...(patch.voiceModel !== undefined ? { voiceModel: patch.voiceModel || undefined } : {}),
      ...(patch.voiceTtsProvider !== undefined
        ? { voiceTtsProvider: patch.voiceTtsProvider || undefined }
        : {}),
      ...(patch.voiceTtsApiKey !== undefined
        ? { voiceTtsApiKey: patch.voiceTtsApiKey || undefined }
        : {}),
      ...(patch.voiceTtsVoice !== undefined
        ? { voiceTtsVoice: patch.voiceTtsVoice || undefined }
        : {}),
      ...(patch.voiceTtsBaseUrl !== undefined
        ? { voiceTtsBaseUrl: patch.voiceTtsBaseUrl || undefined }
        : {}),
      ...(patch.voiceTtsModel !== undefined
        ? { voiceTtsModel: patch.voiceTtsModel || undefined }
        : {}),
    });
  }
}

// `${secrets:ref}` — same indirection syntax the CLI's config loader
// resolves (apps/ethos/src/config.ts).
const SECRETS_REF_RE = /\$\{secrets:([^}]+)\}/g;

/** Coerce the stored `display.streaming_edits` value to the enum. Unset or
 *  unrecognized falls back to the effective default, `'dms'`. */
function parseStreamingEdits(value: string | undefined): 'off' | 'dms' | 'all' {
  return value === 'off' || value === 'all' ? value : 'dms';
}

// ---------------------------------------------------------------------------
// API-key redaction
// ---------------------------------------------------------------------------

/**
 * Render a redacted preview of the active API key. Designed so the user can
 * confirm "which key" is set without leaking enough to use it. Format:
 *   • `sk-…abc1`  — first 3 chars + last 4 (10+ char keys)
 *   • `…abc1`     — last 4 only (6-9 char keys)
 *   • `<unset>`   — empty / undefined
 */
export function redactKey(key: string | undefined): string {
  if (!key) return '<unset>';
  if (key.length >= 10) return `${key.slice(0, 3)}…${key.slice(-4)}`;
  if (key.length >= 6) return `…${key.slice(-4)}`;
  return '<short>'; // <6 chars — almost certainly not a real key
}
