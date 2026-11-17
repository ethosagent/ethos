import type { QuickCommandConfig } from '../section-types';

/** Where a plugin runs (`plugins.isolation`). */
export type PluginIsolationMode = 'in-process' | 'host';

/**
 * The parsed `plugins.isolation*` / `plugins.host.*` keys. Shared with
 * `WiringConfig.pluginIsolation` and the plugin-loader's isolation policy.
 */
export interface PluginIsolationConfig {
  /** `plugins.isolation` — default `in-process`. */
  default: PluginIsolationMode;
  /** `plugins.isolation.<pluginId>` per-plugin overrides. */
  overrides: Record<string, PluginIsolationMode>;
  /** `plugins.host.sandbox` — default `none`. */
  sandbox: 'none' | 'auto';
  /** `plugins.host.hook_timeout_ms` (>= 100) — default 2000. */
  hookTimeoutMs: number;
  /** `plugins.host.idle_stop_minutes` (>= 0) — default 10. */
  idleStopMinutes: number;
  /** `plugins.host.max_heap_mb` (>= 64) — default 512. */
  maxHeapMb: number;
}

export const PLUGIN_ISOLATION_DEFAULTS: Readonly<Omit<PluginIsolationConfig, 'overrides'>> = {
  default: 'in-process',
  sandbox: 'none',
  hookTimeoutMs: 2000,
  idleStopMinutes: 10,
  maxHeapMb: 512,
};

function parseIsolationMode(raw: string): PluginIsolationMode | undefined {
  const v = raw.trim();
  return v === 'in-process' || v === 'host' ? v : undefined;
}

function parseMinInt(raw: string, min: number): number | undefined {
  const v = raw.trim();
  if (!/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= min ? n : undefined;
}

/**
 * Resolve the raw `plugins.isolation*` / `plugins.host.*` values. `undefined`
 * when none is set. An invalid value is a warning and keeps the default.
 */
export function buildPluginIsolation(
  raw: Record<string, string>,
  overrideRaw: Record<string, string>,
): { value?: PluginIsolationConfig; warnings: string[] } {
  const warnings: string[] = [];
  if (Object.keys(raw).length === 0 && Object.keys(overrideRaw).length === 0) {
    return { warnings };
  }
  const value: PluginIsolationConfig = { ...PLUGIN_ISOLATION_DEFAULTS, overrides: {} };
  const bad = (key: string, got: string, want: string, def: unknown): void => {
    warnings.push(`config.yaml: '${key}' must be ${want} (got '${got}'); using ${String(def)}.`);
  };
  if (raw['plugins.isolation'] !== undefined) {
    const m = parseIsolationMode(raw['plugins.isolation']);
    if (m) value.default = m;
    else bad('plugins.isolation', raw['plugins.isolation'], 'in-process or host', value.default);
  }
  for (const [id, v] of Object.entries(overrideRaw)) {
    const m = parseIsolationMode(v);
    if (m) value.overrides[id] = m;
    else bad(`plugins.isolation.${id}`, v, 'in-process or host', 'the default');
  }
  const sb = raw['plugins.host.sandbox'];
  if (sb !== undefined) {
    if (sb.trim() === 'none' || sb.trim() === 'auto') value.sandbox = sb.trim() as 'none' | 'auto';
    else bad('plugins.host.sandbox', sb, 'none or auto', value.sandbox);
  }
  const ints: [string, 'hookTimeoutMs' | 'idleStopMinutes' | 'maxHeapMb', number][] = [
    ['plugins.host.hook_timeout_ms', 'hookTimeoutMs', 100],
    ['plugins.host.idle_stop_minutes', 'idleStopMinutes', 0],
    ['plugins.host.max_heap_mb', 'maxHeapMb', 64],
  ];
  for (const [key, field, min] of ints) {
    const r = raw[key];
    if (r === undefined) continue;
    const n = parseMinInt(r, min);
    if (n !== undefined) value[field] = n;
    else bad(key, r, `an integer >= ${min}`, value[field]);
  }
  return { value, warnings };
}

/** The three `tool_loading` values (reach-and-containment Part 1, D1-5). */
export const TOOL_LOADING_MODES = ['auto', 'on', 'off'] as const;
export type ToolLoadingMode = (typeof TOOL_LOADING_MODES)[number];

/**
 * `tool_loading: auto|on|off`. An unknown value is an error naming the key, not
 * a silent fallback: a typo meant as `off` must not quietly run as `auto`.
 */
export function parseToolLoading(raw: string | undefined): {
  mode?: ToolLoadingMode;
  errors: string[];
} {
  if (raw === undefined) return { errors: [] };
  const mode = TOOL_LOADING_MODES.find((m) => m === raw.trim());
  if (mode) return { mode, errors: [] };
  return {
    errors: [`tool_loading: must be one of ${TOOL_LOADING_MODES.join(', ')} (got '${raw}').`],
  };
}

export function buildQuickCommands(
  kv: Record<string, Record<string, string>>,
): Record<string, QuickCommandConfig> | undefined {
  const result: Record<string, QuickCommandConfig> = {};
  for (const [name, fields] of Object.entries(kv)) {
    const channels = fields.channels
      ? fields.channels
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const shared = {
      ...(fields.gateway === 'true' ? { gateway: true } : {}),
      ...(channels && channels.length > 0 ? { channels } : {}),
    };
    if (fields.type === 'exec' && fields.command) {
      result[name] = { type: 'exec', command: fields.command, ...shared };
    } else if (fields.type === 'reply' && fields.reply) {
      result[name] = { type: 'reply', reply: fields.reply, ...shared };
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function buildChannelToolsets(
  kv: Record<string, string>,
): Record<string, string[]> | undefined {
  const result: Record<string, string[]> = {};
  for (const [platform, raw] of Object.entries(kv)) {
    const tools = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (tools.length > 0) result[platform] = tools;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
