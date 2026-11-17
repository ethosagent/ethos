import type { LogLevel } from '@ethosagent/types';
import type { EthosConfig } from '../config-types';

/** `a2a.enabled` + `a2a.peering.allowPrivateUrls`; undefined when neither is set. */
export function buildA2aConfig(kv: Record<string, string>): EthosConfig['a2a'] {
  const enabled = kv['a2a.enabled'];
  const allowPrivateUrls = kv['a2a.peering.allowPrivateUrls'];
  if (enabled === undefined && allowPrivateUrls === undefined) return undefined;
  return {
    ...(enabled !== undefined ? { enabled: enabled === 'true' } : {}),
    ...(allowPrivateUrls !== undefined
      ? { peering: { allowPrivateUrls: allowPrivateUrls === 'true' } }
      : {}),
  };
}

/** Accepted `logs.level` values, ordered by severity. Mirrors `LogLevel`. */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function parseVerbosity(v: string | undefined): EthosConfig['displayVerbosity'] {
  return v === 'quiet' || v === 'default' || v === 'verbose' || v === 'debug' ? v : undefined;
}

export function parseBusyMode(v: string | undefined): EthosConfig['displayBusyInputMode'] {
  return v === 'interrupt' || v === 'queue' || v === 'steer' ? v : undefined;
}

export function parseStreamingEdits(v: string | undefined): EthosConfig['displayStreamingEdits'] {
  return v === 'off' || v === 'dms' || v === 'all' ? v : undefined;
}

export function parseCallStyle(v: string | undefined): EthosConfig['displayCallStyle'] {
  return v === 'liquid' || v === 'orb' || v === 'rings' || v === 'personality' ? v : undefined;
}

export function parseToolPreviewLength(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return undefined;
  return n;
}

/** The largest `timeout` a *correct* config can express: the roster field's own
 *  declared ceiling (`min(1).max(3600)` in `@ethosagent/web-contracts`). */
const AUX_TIMEOUT_MAX_SECONDS = 3600;

/**
 * SHIM — `auxiliary.{asr,tts}.timeout` is SECONDS (the `command-stt` /
 * `command-tts` providers multiply it by 1000), but the web UI shipped the
 * field labelled and bounded in milliseconds, so existing configs carry values
 * like `30000` — an 8h20m budget, i.e. a timeout that never fires.
 *
 * A value above {@link AUX_TIMEOUT_MAX_SECONDS} is therefore read as
 * milliseconds. That threshold is above the maximum a correct config can
 * express, so there is no legitimate value in the misfire range — no single
 * speech request has a multi-hour budget.
 *
 * Removed in the minor release after the one that ships the seconds label —
 * tracked as `aux-timeout-shim-removal` in `plan/uncompleted-tasks.md`.
 */
export function normalizeAuxTimeoutSeconds(raw: number): { seconds: number; coerced: boolean } {
  if (raw <= AUX_TIMEOUT_MAX_SECONDS) return { seconds: raw, coerced: false };
  return {
    seconds: Math.min(AUX_TIMEOUT_MAX_SECONDS, Math.max(1, Math.round(raw / 1000))),
    coerced: true,
  };
}

/** {@link normalizeAuxTimeoutSeconds} over one default entry, appending the
 *  one-per-load warning to `warnings` when it coerces. */
export function normalizeAuxEntryTimeout<E extends { timeout?: number }>(
  entry: E | undefined,
  key: string,
  warnings: string[],
): E | undefined {
  if (!entry || entry.timeout === undefined) return entry;
  const { seconds, coerced } = normalizeAuxTimeoutSeconds(entry.timeout);
  if (!coerced) return entry;
  warnings.push(
    `${key}: ${entry.timeout} looks like milliseconds — this field is seconds. ` +
      `Reading it as ${seconds}s. Set it to ${seconds} in ~/.ethos/config.yaml to make it ` +
      'explicit; this shim is removed in the next minor.',
  );
  return { ...entry, timeout: seconds };
}

/**
 * §5 — assemble the global compaction thresholds from parsed flat keys.
 * `pressure`/`target` are kept only when they parse to a finite fraction in
 * (0,1]; out-of-range or non-numeric values are dropped. Returns `undefined`
 * when neither field survives, so the gate falls back to its 0.8/0.7 defaults.
 */
export function buildCompaction(kv: Record<string, string>): EthosConfig['compaction'] | undefined {
  const result: NonNullable<EthosConfig['compaction']> = {};
  for (const key of ['pressure', 'target'] as const) {
    const raw = kv[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n <= 1) result[key] = n;
  }
  // Phase 1c — gateDelta is a token headroom (non-negative integer), not a
  // fraction; validated on a different range from pressure/target.
  const rawDelta = kv.gateDelta;
  if (rawDelta !== undefined) {
    const d = Number(rawDelta);
    if (Number.isFinite(d) && d >= 0) result.gateDelta = Math.floor(d);
  }
  // Phase 3 — boolean flags for the turn-end trigger + overflow-retry.
  if (kv.autoCompact === 'true') result.autoCompact = true;
  else if (kv.autoCompact === 'false') result.autoCompact = false;
  if (kv.retryOnOverflow === 'true') result.retryOnOverflow = true;
  else if (kv.retryOnOverflow === 'false') result.retryOnOverflow = false;
  // Item 7 — surface a failed emergency summary as its own error instead of
  // masking it as the generic overflow rejection. Default off.
  if (kv.abortOnSummaryFailure === 'true') result.abortOnSummaryFailure = true;
  else if (kv.abortOnSummaryFailure === 'false') result.abortOnSummaryFailure = false;
  // Phase 4 — small-window-mode override (auto | on | off).
  if (kv.smallWindow === 'auto' || kv.smallWindow === 'on' || kv.smallWindow === 'off') {
    result.smallWindow = kv.smallWindow;
  }
  // Item 7 — absolute ceiling (positive integer tokens) + guaranteed user tail
  // (non-negative integer). Out-of-range values are dropped, as above.
  const rawCeiling = kv.maxContextTokens;
  if (rawCeiling !== undefined) {
    const c = Number(rawCeiling);
    if (Number.isFinite(c) && c > 0) result.maxContextTokens = Math.floor(c);
  }
  const rawTail = kv.minTailUserMessages;
  if (rawTail !== undefined) {
    const t = Number(rawTail);
    if (Number.isFinite(t) && t >= 0) result.minTailUserMessages = Math.floor(t);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
