import { EthosError } from '@ethosagent/types';
export class ConfigService {
  opts;
  constructor(opts) {
    this.opts = opts;
  }
  async get() {
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
    };
  }
  async update(patch) {
    // Empty-string apiKey would erase the existing key. Treat as no-op.
    const cleaned = { ...patch };
    if (cleaned.apiKey !== undefined && cleaned.apiKey === '') delete cleaned.apiKey;
    // Convert providers to repository format when present.
    let repoProviders;
    if (cleaned.providers) {
      repoProviders = cleaned.providers.map((p) => {
        const entry = { provider: p.provider };
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
export function redactKey(key) {
  if (!key) return '<unset>';
  if (key.length >= 10) return `${key.slice(0, 3)}…${key.slice(-4)}`;
  if (key.length >= 6) return `…${key.slice(-4)}`;
  return '<short>'; // <6 chars — almost certainly not a real key
}
