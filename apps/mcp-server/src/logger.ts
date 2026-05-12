// Structured JSON logger — writes exclusively to stderr.
// stdout must be pure JSON-RPC frames; any stray output will corrupt MCP clients.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface McpLogger {
  debug: (msg: string, data?: unknown) => void;
  info: (msg: string, data?: unknown) => void;
  warn: (msg: string, data?: unknown) => void;
  error: (msg: string, data?: unknown) => void;
}

function write(level: LogLevel, msg: string, data?: unknown): void {
  const entry: Record<string, unknown> = { level, msg, ts: new Date().toISOString() };
  if (data !== undefined) entry.data = data;
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export const logger: McpLogger = {
  debug: (msg, data) => write('debug', msg, data),
  info: (msg, data) => write('info', msg, data),
  warn: (msg, data) => write('warn', msg, data),
  error: (msg, data) => write('error', msg, data),
};
