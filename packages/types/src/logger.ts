// Logger contract for library output.
//
// Library code (everything outside designated app entry points) emits all
// human-readable output through this interface — never directly to stdout
// or stderr. Apps install a concrete Logger at composition time; when
// none is installed, the framework substitutes a no-op so libraries stay
// silent.
//
// Implementations ship in @ethosagent/logger (NoopLogger, ConsoleLogger).
// See ARCHITECTURE.md §III Law 10.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Convention: `err` carries the underlying Error (pino-compatible) so
// implementations can render its message + stack uniformly without
// every call site having to pre-stringify. Other keys flow as-is.
export type LogMeta = { err?: unknown } & Record<string, unknown>;

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;

  // Returns a Logger that prefixes every record with the given metadata.
  // Useful for component-scoped loggers (e.g. logger.child({ component: 'cron' })).
  child(meta: LogMeta): Logger;
}
