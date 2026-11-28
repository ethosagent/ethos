/**
 * FW-16 / context-economy Phase 1 — user-defined `/name` shortcuts.
 * `exec` runs an operator-authored shell command; `reply` returns a canned
 * string with no shell involved. `gateway: true` (default false) exposes the
 * command to channel messages via the `gateway_message` claiming hook;
 * `channels` optionally restricts that exposure to the listed platforms.
 * Channel text is only ever exact-matched against `/name` — it is never
 * interpolated into `command`.
 */
export type QuickCommandConfig =
  | { type: 'exec'; command: string; gateway?: boolean; channels?: string[] }
  | { type: 'reply'; reply: string; gateway?: boolean; channels?: string[] };

/**
 * Auxiliary model wiring for non-primary work. Today the only consumer is
 * context compression: `semantic_summary` runs its summarizer on this
 * (typically cheap) model so a compacting turn costs ~one Haiku-tier call
 * instead of a full main-model re-prompt. `provider` / `apiKey` / `baseUrl`
 * default to the primary provider's values when unset.
 */
export interface AuxiliaryCompressionConfig {
  model: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * tools-vision P2 — auxiliary vision model wiring. `vision_analyze` uses this
 * (typically vision-capable) model when the active personality's primary
 * model can't handle images / PDFs, or when the user wants to route vision
 * traffic to a cheaper model. `provider` / `apiKey` / `baseUrl` default to
 * the primary provider's values when unset, same as compression.
 */
export interface AuxiliaryVisionConfig {
  model: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * tools-web — auxiliary model for web_extract summarization. Same shape as
 * compression/vision. When set, web_extract summarizes large pages via this
 * (typically cheap) model instead of returning truncated raw text.
 */
export interface AuxiliaryWebConfig {
  model: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * tools-web — web search/extract backend selection, plus the web API
 * server's bind address, port, and CORS origins (`web.host` / `web.port` /
 * `web.corsOrigins`). Two unrelated features share this block because the
 * config-file key is `web.*` in both cases — do not split into two
 * top-level `web:` keys.
 */
export interface WebConfig {
  search_backend?: 'exa' | 'tavily' | 'brave';
  extract_backend?: 'htmltext';
  /** `--web-host` / `ETHOS_WEB_HOST` default when unset. */
  host?: string;
  /** `--web-port` / `ETHOS_WEB_PORT` default when unset. */
  port?: number;
  /** `ETHOS_API_CORS_ORIGINS` default when unset. Comma-separated origins or `*`. */
  corsOrigins?: string;
  /**
   * Self-hosted SearXNG metasearch endpoint (`web.searxng.url`) — an optional
   * extra rung for `web_search`. Absent means the rung is not offered. Taken
   * verbatim, like `host` and `corsOrigins`: every other string in this block
   * is unvalidated and a wrong endpoint fails loudly at the first search.
   */
  searxng?: { url: string };
}

/**
 * Remote model catalog configuration. Controls how Ethos fetches and caches
 * the centralized model metadata catalog (capabilities, context windows, pricing).
 */
export interface ModelCatalogConfig {
  /** Whether remote catalog fetching is enabled. Default true. */
  enabled?: boolean;
  /** URL of the catalog JSON endpoint. Default: https://ethos-agent.ai/api/model-catalog.json */
  url?: string;
  /** Cache TTL in hours. Default: 24. */
  ttlHours?: number;
  /** Per-provider URL overrides for catalog endpoints. */
  providers?: Record<string, { url: string }>;
}

export interface AwsSecretsConfig {
  enabled?: boolean;
  region?: string;
  prefix?: string;
  endpoint?: string;
}

export interface AwsConfig {
  secrets?: AwsSecretsConfig;
}

/**
 * Langfuse export target (analytics-observability plan, Part E / D7).
 * `secretKey` is a real credential and is vaulted like every other provider
 * secret in this codebase (see `SECRET_FIELD_NAMES`); `publicKey` is not —
 * Langfuse's own docs treat it the same as a client id.
 */
export interface TelemetryLangfuseExportConfig {
  /** Default false — export is opt-in. */
  enabled?: boolean;
  baseUrl?: string;
  publicKey?: string;
  secretKey?: string;
}

/**
 * OTLP/HTTP export target (otlp-export plan, §4.4 / D7 / D8). Every header
 * VALUE is a credential: header names are free (`Authorization`,
 * `x-honeycomb-team`, `api-key`), so there is no safe subset to leave
 * plaintext — each `headers.<Name>` value is vaulted as
 * `telemetry/export/otlp/headers/<Name>` on write and resolved on read.
 * OTel env vars override `endpoint`/`headers` but never enable export;
 * `resolveOtlpSettings` in `@ethosagent/export-otlp` applies that precedence.
 */
export interface TelemetryOtlpExportConfig {
  /** Default false — export is opt-in (env vars never enable it). */
  enabled?: boolean;
  /** Base URL; `/v1/traces` is appended by the exporter. */
  endpoint?: string;
  /** Collector headers by name. Every value is vaulted (D7). */
  headers?: Record<string, string>;
  /** Default false — tool args and event cause/details stay local (D6). */
  includeContent?: boolean;
  /** Poll interval. Default 15000ms. */
  intervalMs?: number;
  /** Unexported traces older than this are dropped, not shipped (D11).
   *  Default 86400000ms (24h). */
  backlogMaxAgeMs?: number;
}

export interface TelemetryExportConfig {
  langfuse?: TelemetryLangfuseExportConfig;
  otlp?: TelemetryOtlpExportConfig;
}

export interface TelemetryConfig {
  export?: TelemetryExportConfig;
}

/**
 * On-disk schema version for `~/.ethos/config.yaml`. Bump on a breaking
 * field rename, type change, or required-field addition; do NOT bump on
 * additive optional fields. The loader uses this to drive migrations in
 * future releases without guessing whether an unknown field is an
 * operator typo or an older shape.
 *
 * Current shape lives at version 1. Pre-versioned configs (created before
 * this field shipped) load with a one-line deprecation warning and are
 * treated as `1`; the writer always emits the current value going
 * forward.
 */
export const CURRENT_ETHOS_CONFIG_SCHEMA_VERSION = 1;

/** The personality `parseConfigYaml` falls back to when `personality:` is
 *  absent — surfaced by `resolveEffectiveConfig` as source `default`. */
export const DEFAULT_PERSONALITY_ID = 'researcher';

/** Scale-to-zero idle watcher (moved out of config-types.ts's inline member type, size ratchet). */
export interface IdleWatcherConfig {
  /** Arming gate 1. Default false — the watcher is not even constructed. */
  enabled?: boolean;
  /** Arming gate 5 — consecutive idle duration required before exit fires. */
  idleThresholdMs?: number;
  /** Arming gate 4 — no evaluation for this long after boot. */
  startupCooldownMs?: number;
  /** How often the idle predicate is sampled. */
  checkIntervalMs?: number;
  /** Arming gate 3 — operator attestation that a wake path exists. */
  wakePathConfirmed?: boolean;
}

/** Global share-link switch (plan share-links D11). Absent means off and nothing excluded. */
export interface ShareLinksConfig {
  /** Default false. Only a literal `true` turns share links on. */
  enabled?: boolean;
  /** Personality ids whose sessions cannot be shared (comma-separated in config.yaml). */
  excludePersonalities?: string[];
}

export interface NodesConfig {
  /** Operator switch for laptop tool nodes (plan laptop-tool-node D18). Default false: no /node routes, no node_* tools. */
  enabled?: boolean;
}

/** World model block (plan world-model 4.6). Absent means off. Read via `resolveWorld`. */
export interface WorldConfig {
  /** Default false. Off means no world tools, no injector and no extraction are composed. */
  enabled?: boolean;
  /** Default 2400, clamped to [0, 8000]. Budget of the world block in the dynamic tail. */
  contextMaxChars?: number;
  /** Default 2. Graph hops the injector expands from a seed entity. */
  contextHops?: 1 | 2;
  /** Default 'off'. 'propose' sends extracted facts to the proposal queue (plan P6). */
  extraction?: 'off' | 'propose';
  /** Defaults 500 / 30. */
  proposals?: { cap?: number; ttlDays?: number };
}
