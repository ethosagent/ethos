// Phase 30.10 — local error log.
//
// Every `EthosError` rendered through the surface path is appended as one
// JSON line to `~/.ethos/logs/errors.jsonl`. Local-only — no upload, no
// telemetry. Rotates to `errors.jsonl.1`, `errors.jsonl.2`, … up to maxFiles
// when the file exceeds maxBytes (default: 10 MiB, 5 backups).
//
// Surfaced via `ethos doctor --recent-errors` so users can see "I've hit
// PROVIDER_AUTH_FAILED 12 times this week" without filing an issue.
//
// Log writes are best-effort: if the disk is full or the directory is
// read-only, we silently drop the line rather than masking the original
// error. The original error still renders to stderr.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { ethosDir } from './config';

let _obs;
/**
 * Wire up an observability adapter so errors are also written to
 * observability.db. Call this once during CLI startup with the app's
 * EthosObservability adapter (or any object exposing `recordError`).
 */
export function setObservabilityService(obs) {
  _obs = obs;
}
const DEFAULT_ROTATION = {
  maxBytes: 10 * 1024 * 1024,
  maxFiles: 5,
  enabled: true,
};
let _rotation = DEFAULT_ROTATION;
/**
 * Override the default rotation config. Call this once during CLI startup,
 * e.g. from wiring.ts after reading ~/.ethos/config.yaml.
 */
export function setRotationConfig(config) {
  const merged = { ...DEFAULT_ROTATION, ...config };
  if (!Number.isFinite(merged.maxBytes) || merged.maxBytes <= 0)
    merged.maxBytes = DEFAULT_ROTATION.maxBytes;
  if (!Number.isFinite(merged.maxFiles) || merged.maxFiles < 1)
    merged.maxFiles = DEFAULT_ROTATION.maxFiles;
  _rotation = merged;
}
function logsDir() {
  return join(ethosDir(), 'logs');
}
function logPath() {
  return join(logsDir(), 'errors.jsonl');
}
export function rotateIfNeeded(filePath, config) {
  if (!config.enabled) return;
  if (!Number.isFinite(config.maxBytes) || config.maxBytes <= 0) return;
  if (!Number.isFinite(config.maxFiles) || config.maxFiles < 1) return;
  const maxFiles = Math.floor(config.maxFiles);
  try {
    const stat = statSync(filePath);
    if (stat.size < config.maxBytes) return;
  } catch {
    return; // file doesn't exist yet
  }
  // Delete oldest backup if at max count
  try {
    unlinkSync(`${filePath}.${maxFiles}`);
  } catch {
    /* ok — missing is fine */
  }
  // Shift existing backups: .N → .N+1
  for (let i = maxFiles - 1; i >= 1; i--) {
    try {
      renameSync(`${filePath}.${i}`, `${filePath}.${i + 1}`);
    } catch {
      /* ok — missing is fine */
    }
  }
  // Rename current log → .1
  try {
    renameSync(filePath, `${filePath}.1`);
  } catch {
    /* ok */
  }
}
/**
 * Append one error to `~/.ethos/logs/errors.jsonl`. Best-effort — failures
 * are swallowed so the surface error still renders. Synchronous so the
 * top-level handler can run it before `process.exit(1)`.
 */
export function appendErrorLog(err, ctx = {}) {
  try {
    mkdirSync(logsDir(), { recursive: true });
    rotateIfNeeded(logPath(), _rotation);
    const entry = {
      ts: new Date().toISOString(),
      code: err.code,
      cause: err.cause,
      action: err.action,
      ...(err.details !== undefined && { details: err.details }),
      ...ctx,
    };
    appendFileSync(logPath(), `${JSON.stringify(entry)}\n`);
    try {
      _obs?.recordError({
        code: err.code,
        cause: err.cause,
        details: { action: err.action, ...ctx },
      });
    } catch {
      // Observability is best-effort — never mask the primary log write.
    }
  } catch {
    // Disk full, perms, ENOSPC — drop the entry, surface error still prints.
  }
}
/**
 * Read the most recent N errors from the log (newest first). Returns [] if
 * the file is missing or unreadable.
 */
export function readRecentErrors(limit = 50) {
  try {
    const raw = readFileSync(logPath(), 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const tail = lines.slice(-limit);
    const out = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // Skip malformed lines rather than fail the whole report.
      }
    }
    return out.reverse();
  } catch {
    return [];
  }
}
/** True if the log file exists. Used by `doctor --recent-errors` to message empty state. */
export function errorLogExists() {
  return existsSync(logPath());
}
/** Path to the log file, for messages and tests. */
export function errorLogPath() {
  return logPath();
}
