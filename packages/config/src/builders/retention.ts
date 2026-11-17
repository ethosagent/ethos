import {
  isRetentionDuration,
  type RetentionConfig,
  type RetentionEventsConfig,
} from '@ethosagent/types';

/** The `retention.*` and `personalities.<id>.retention.*` keys whose value is a
 *  duration. `vacuumAfterPrune` / `minVacuumIntervalDays` are not. */
const RETENTION_DURATION_FIELDS = [
  'messages',
  'traces',
  'spans',
  'blobs',
  'archive',
  'channelTranscript',
] as const;

const RETENTION_EVENT_FIELDS = ['error', 'audit', 'channel', 'install'] as const;

/**
 * Take one retention duration off the raw map, or drop it with a warning.
 *
 * Nothing downstream validates these. `parseDuration`
 * (`extensions/observability-sqlite/src/retention.ts:5`) THROWS on any value
 * outside {@link RETENTION_DURATION_PATTERN}, and its production caller — the
 * `observability-prune` cron handler in `apps/ethos/src/wiring.ts:182` — does
 * not guard the call. So a hand-written typo booted cleanly and then threw
 * inside the nightly handler, disabling pruning for every category with no
 * operator-visible symptom. Checking it here moves that to a place an operator
 * reads: parse warnings are printed by `ethos doctor`
 * (`runDoctor` in `apps/ethos/src/commands/doctor.ts`), `ethos serve`
 * (`runServe` in `commands/serve.ts`), and the gateway/boot deprecation banners.
 *
 * Dropped, not fatal, and dropped rather than kept: the category falls back to
 * its `RETENTION_DEFAULTS` window, so pruning keeps running. Same posture as
 * `vacuumAfterPrune` below and as the web reader in
 * `apps/web-api/src/services/config.service.ts` — a value the runtime will not
 * honour reads back as unset rather than as a string that breaks the consumer.
 */
function retentionDuration(
  raw: string | undefined,
  keyPath: string,
  warnings: string[],
): string | undefined {
  if (!raw) return undefined;
  if (isRetentionDuration(raw)) return raw;
  warnings.push(
    `${keyPath}: "${raw}" is not a retention duration. Expected \`forever\`, or a whole ` +
      'number followed by d/w/m/y (e.g. `30d`, `12w`, `1y`) — hours and minutes are not in ' +
      'the grammar. Ignoring it; this category prunes on its default window.',
  );
  return undefined;
}

export function buildRetentionConfig(
  kv: Record<string, string>,
  keyPrefix: string,
  warnings: string[],
): RetentionConfig | undefined {
  if (Object.keys(kv).length === 0) return undefined;
  const cfg: RetentionConfig = {};
  for (const field of RETENTION_DURATION_FIELDS) {
    const value = retentionDuration(kv[field], `${keyPrefix}.${field}`, warnings);
    if (value) cfg[field] = value;
  }
  const ev: RetentionEventsConfig = {};
  for (const field of RETENTION_EVENT_FIELDS) {
    const value = retentionDuration(
      kv[`events.${field}`],
      `${keyPrefix}.events.${field}`,
      warnings,
    );
    if (value) ev[field] = value;
  }
  if (Object.keys(ev).length > 0) cfg.events = ev;
  // Item 6 — post-prune VACUUM. `vacuumAfterPrune` is a strict boolean; a typo
  // leaves it undefined (opt-in stays off). `minVacuumIntervalDays` is a
  // non-negative integer number of days; anything else is dropped.
  if (kv.vacuumAfterPrune === 'true') cfg.vacuumAfterPrune = true;
  else if (kv.vacuumAfterPrune === 'false') cfg.vacuumAfterPrune = false;
  const minInterval = Number(kv.minVacuumIntervalDays);
  if (kv.minVacuumIntervalDays !== undefined && Number.isFinite(minInterval) && minInterval >= 0) {
    cfg.minVacuumIntervalDays = Math.floor(minInterval);
  }
  return cfg;
}

export function buildPersonalitiesConfig(
  kv: Record<string, Record<string, string>>,
  warnings: string[],
): Record<string, { retention?: RetentionConfig }> | undefined {
  if (Object.keys(kv).length === 0) return undefined;
  const out: Record<string, { retention?: RetentionConfig }> = {};
  for (const [pid, retKv] of Object.entries(kv)) {
    const retention = buildRetentionConfig(retKv, `personalities.${pid}.retention`, warnings);
    if (retention) out[pid] = { retention };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Serialize a RetentionConfig to dotted key-value pairs. */
export function retentionToLines(cfg: RetentionConfig): Array<[string, string]> {
  const lines: Array<[string, string]> = [];
  if (cfg.messages) lines.push(['messages', cfg.messages]);
  if (cfg.traces) lines.push(['traces', cfg.traces]);
  if (cfg.spans) lines.push(['spans', cfg.spans]);
  if (cfg.blobs) lines.push(['blobs', cfg.blobs]);
  if (cfg.archive) lines.push(['archive', cfg.archive]);
  if (cfg.channelTranscript) lines.push(['channelTranscript', cfg.channelTranscript]);
  if (cfg.events) {
    if (cfg.events.error) lines.push(['events.error', cfg.events.error]);
    if (cfg.events.audit) lines.push(['events.audit', cfg.events.audit]);
    if (cfg.events.channel) lines.push(['events.channel', cfg.events.channel]);
    if (cfg.events.install) lines.push(['events.install', cfg.events.install]);
  }
  if (cfg.vacuumAfterPrune !== undefined) {
    lines.push(['vacuumAfterPrune', String(cfg.vacuumAfterPrune)]);
  }
  if (cfg.minVacuumIntervalDays !== undefined) {
    lines.push(['minVacuumIntervalDays', String(cfg.minVacuumIntervalDays)]);
  }
  return lines;
}
