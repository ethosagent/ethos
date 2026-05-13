import type { Logger, LogLevel, LogMeta } from '@ethosagent/types';

// Silent logger — the default when an app does not install one. Library
// code wired through here produces zero output until composition swaps in
// something concrete.
export class NoopLogger implements Logger {
  debug(_message: string, _meta?: LogMeta): void {}
  info(_message: string, _meta?: LogMeta): void {}
  warn(_message: string, _meta?: LogMeta): void {}
  error(_message: string, _meta?: LogMeta): void {}
  child(_meta: LogMeta): Logger {
    return this;
  }
}

export const noopLogger: Logger = new NoopLogger();

// Routes log records to console.* for app entry points that want plain
// text output. Apps that need structured output ship their own Logger
// (pino, etc.) — this is the framework's default for ergonomic CLI use.
export class ConsoleLogger implements Logger {
  private readonly baseMeta: LogMeta;

  constructor(baseMeta: LogMeta = {}) {
    this.baseMeta = baseMeta;
  }

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
    return new ConsoleLogger({ ...this.baseMeta, ...meta });
  }

  private emit(level: LogLevel, message: string, meta?: LogMeta): void {
    const merged = meta ? { ...this.baseMeta, ...meta } : this.baseMeta;
    const prefix = formatPrefix(merged);
    const suffix = formatSuffix(merged);
    const text = [prefix, message, suffix].filter(Boolean).join(' ');
    // ConsoleLogger is itself an app-entry-point shim; the constitution
    // explicitly permits console.* in app entry modules.
    if (level === 'error') {
      console.error(text);
    } else if (level === 'warn') {
      console.warn(text);
    } else if (level === 'debug') {
      console.debug(text);
    } else {
      console.log(text);
    }
  }
}

function formatPrefix(meta: LogMeta): string {
  const component = meta.component;
  if (typeof component === 'string' && component.length > 0) {
    return `[${component}]`;
  }
  return '';
}

// Render remaining meta as ` key=value` pairs, plus the err stack on
// its own line when present. Skip the `component` key — formatPrefix
// already surfaced it.
function formatSuffix(meta: LogMeta): string {
  const parts: string[] = [];
  let errLine = '';
  for (const [key, value] of Object.entries(meta)) {
    if (key === 'component') continue;
    if (key === 'err') {
      errLine = formatErr(value);
      continue;
    }
    parts.push(`${key}=${formatValue(value)}`);
  }
  const tail = parts.join(' ');
  if (tail && errLine) return `${tail}\n${errLine}`;
  return tail || errLine;
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  // Object / array: JSON for stability; fall back to String() if cyclic.
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatErr(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  return `err=${formatValue(value)}`;
}
