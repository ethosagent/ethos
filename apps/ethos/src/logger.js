import pino from 'pino';
// Logs go to stderr so they never collide with ACP JSON-RPC on stdout.
// Default level is 'warn' — silent in normal CLI use; override with LOG_LEVEL=debug.
export const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' }, process.stderr);
const ETHOS_VERSION =
  typeof __ETHOS_VERSION__ === 'string' ? __ETHOS_VERSION__ : (process.env.ETHOS_VERSION ?? 'dev');
/**
 * Emit a single structured JSON line signalling that a long-running command
 * is ready to accept work. Clawrium greps for `event === 'ethos.ready'`.
 *
 * Writes directly to stderr, bypassing the pino logger, so the signal is
 * always emitted regardless of LOG_LEVEL.
 */
export function emitReady(command) {
  const payload = {
    event: 'ethos.ready',
    command,
    version: ETHOS_VERSION,
    pid: process.pid,
    timestamp: new Date().toISOString(),
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}
