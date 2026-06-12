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
    });
  }
}

// `${secrets:ref}` — same indirection syntax the CLI's config loader
// resolves (apps/ethos/src/config.ts).
const SECRETS_REF_RE = /\$\{secrets:([^}]+)\}/g;

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
