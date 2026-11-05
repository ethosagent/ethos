import type { Logger, LogLevel, LogMeta } from '@ethosagent/types';
import pino from 'pino';

// Logs go to stderr so they never collide with ACP JSON-RPC on stdout.
// Default level is 'warn' — silent in normal CLI use; override with LOG_LEVEL=debug.
export const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' }, process.stderr);

// Clawrium compatibility: version injected at build time, falling back to env or 'dev'.
declare const __ETHOS_VERSION__: string;
const ETHOS_VERSION =
  typeof __ETHOS_VERSION__ === 'string' ? __ETHOS_VERSION__ : (process.env.ETHOS_VERSION ?? 'dev');

/**
 * Emit a single structured JSON line signalling that a long-running command
 * is ready to accept work. Clawrium greps for `event === 'ethos.ready'`.
 *
 * Writes directly to stderr, bypassing the pino logger, so the signal is
 * always emitted regardless of LOG_LEVEL.
 */
export function emitReady(command: string): void {
  const payload = {
    event: 'ethos.ready',
    command,
    version: ETHOS_VERSION,
    pid: process.pid,
    timestamp: new Date().toISOString(),
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Plain-text logger that writes EVERY level to stderr, in the same
 * `[component] message key=value` shape as `ConsoleLogger` (which sends `info`
 * to stdout via console.log). For one-shot CLI commands whose stdout is
 * user-facing output that may be piped. Unlike the pino `logger` above it
 * defaults to the full range, so info-level audit lines are not silenced.
 */
export class StderrLogger implements Logger {
  constructor(
    private readonly baseMeta: LogMeta = {},
    private readonly minLevel: LogLevel = 'debug',
  ) {}

  debug(message: string, meta?: LogMeta): void {
    this.emit('debug', message, meta);
  }
  info(message: string, meta?: LogMeta): void {
    this.emit('info', message, meta);
  }
  warn(message: string, meta?: LogMeta): void {
    this.emit('warn', message, meta);
  }
  error(message: string, meta?: LogMeta): void {
    this.emit('error', message, meta);
  }
  child(meta: LogMeta): Logger {
    return new StderrLogger({ ...this.baseMeta, ...meta }, this.minLevel);
  }

  private emit(level: LogLevel, message: string, meta?: LogMeta): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;
    const { component, err, ...rest } = { ...this.baseMeta, ...meta };
    const parts = Object.entries(rest).map(([k, v]) => `${k}=${formatValue(v)}`);
    const errLine =
      err instanceof Error
        ? (err.stack ?? `${err.name}: ${err.message}`)
        : err === undefined
          ? ''
          : `err=${formatValue(err)}`;
    const tail = parts.join(' ');
    const suffix = tail && errLine ? `${tail}\n${errLine}` : tail || errLine;
    const prefix = typeof component === 'string' && component ? `[${component}]` : '';
    process.stderr.write(`${[prefix, message, suffix].filter(Boolean).join(' ')}\n`);
  }
}
