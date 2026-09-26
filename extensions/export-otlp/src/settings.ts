import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

// ---------------------------------------------------------------------------
// Settings resolution (D5/D8 of plan/phases/otlp-export.md). The OTel
// exporter env vars OVERRIDE config values per the OTel spec, but they never
// ENABLE export: only `telemetry.export.otlp.enabled: true` in config does —
// an `OTEL_*` variable inherited from a container base image must not start
// sending agent telemetry off-box.
// ---------------------------------------------------------------------------

/** The `telemetry.export.otlp.*` block, shaped structurally so this package
 *  does not depend on `@ethosagent/config` (lane C adds the parsed type
 *  there). */
export interface OtlpExportConfigInput {
  enabled?: boolean;
  endpoint?: string;
  headers?: Record<string, string>;
  includeContent?: boolean;
  intervalMs?: number;
  backlogMaxAgeMs?: number;
}

export interface OtlpSettings {
  /** Full URL the trace POSTs go to (already includes `/v1/traces` unless
   *  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` supplied a verbatim URL). */
  tracesUrl: string;
  headers: Record<string, string>;
  includeContent: boolean;
  intervalMs: number;
  backlogMaxAgeMs: number;
  timeoutMs: number;
  /** Resource attributes, constant per process (D5). */
  resource: Record<string, string | number>;
}

export interface OtlpDisabled {
  disabled: true;
  reason: string;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_INTERVAL_MS = 15_000;
export const DEFAULT_BACKLOG_MAX_AGE_MS = 86_400_000;

/** Comma-separated `key=value` pairs, values percent-decoded — the format
 *  shared by `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_RESOURCE_ATTRIBUTES`
 *  (W3C baggage without properties). A malformed entry is skipped, and a
 *  value that fails percent-decoding is kept raw. */
function parsePairs(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const entry of raw.split(',')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).trim();
    const rawValue = entry.slice(eq + 1).trim();
    if (!key) continue;
    let value = rawValue;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      // Not valid percent-encoding — use the raw value.
    }
    out[key] = value;
  }
  return out;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function parseTimeout(raw: string | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.floor(parsed);
}

/**
 * Resolve the effective OTLP export settings from the config block and the
 * process environment. Returns `{ disabled: true, reason }` when export must
 * not run; the reason is operator-readable and names the deciding input.
 *
 * `serviceVersion` is the CLI package version, passed in by the caller —
 * this package cannot know it. Omitted, `service.version` is absent from
 * the resource.
 */
export function resolveOtlpSettings(
  config: OtlpExportConfigInput | undefined,
  env: Record<string, string | undefined>,
  opts?: { serviceVersion?: string },
): OtlpSettings | OtlpDisabled {
  if (config?.enabled !== true) {
    return {
      disabled: true,
      reason: 'telemetry.export.otlp.enabled is not true (env vars never enable export)',
    };
  }
  if (env.OTEL_SDK_DISABLED === 'true') {
    return { disabled: true, reason: 'OTEL_SDK_DISABLED=true' };
  }
  const protocol = env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if (protocol !== undefined && protocol !== 'http/json') {
    return {
      disabled: true,
      reason: `unsupported OTEL_EXPORTER_OTLP_PROTOCOL "${protocol}" — only http/json is supported`,
    };
  }

  // Endpoint precedence: the traces-specific env var is used VERBATIM (the
  // OTel spec says it is the full URL); the generic env var and the config
  // endpoint are base URLs that get the signal path appended.
  let tracesUrl: string;
  if (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
    tracesUrl = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  } else if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    tracesUrl = `${stripTrailingSlash(env.OTEL_EXPORTER_OTLP_ENDPOINT)}/v1/traces`;
  } else if (config.endpoint) {
    tracesUrl = `${stripTrailingSlash(config.endpoint)}/v1/traces`;
  } else {
    return { disabled: true, reason: 'no endpoint configured' };
  }

  // Headers merge lowest-precedence first: config, then the generic env var,
  // then the traces-specific env var.
  const headers: Record<string, string> = {
    ...(config.headers ?? {}),
    ...parsePairs(env.OTEL_EXPORTER_OTLP_HEADERS),
    ...parsePairs(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
  };

  // Resource (D5): defaults, then OTEL_RESOURCE_ATTRIBUTES pairs win over
  // defaults, then OTEL_SERVICE_NAME wins over everything for service.name.
  const resource: Record<string, string | number> = {
    'service.name': 'ethos',
    ...(opts?.serviceVersion !== undefined ? { 'service.version': opts.serviceVersion } : {}),
    'service.instance.id': randomUUID(),
    'host.name': hostname(),
    'process.pid': process.pid,
  };
  for (const [key, value] of Object.entries(parsePairs(env.OTEL_RESOURCE_ATTRIBUTES))) {
    resource[key] = value;
  }
  if (env.OTEL_SERVICE_NAME) resource['service.name'] = env.OTEL_SERVICE_NAME;

  return {
    tracesUrl,
    headers,
    includeContent: config.includeContent === true,
    intervalMs: config.intervalMs ?? DEFAULT_INTERVAL_MS,
    backlogMaxAgeMs: config.backlogMaxAgeMs ?? DEFAULT_BACKLOG_MAX_AGE_MS,
    timeoutMs: parseTimeout(env.OTEL_EXPORTER_OTLP_TIMEOUT),
    resource,
  };
}
