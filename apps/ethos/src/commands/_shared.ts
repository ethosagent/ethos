// Constants and small helpers shared across the command modules, so each has
// one copy instead of one per command:
//   - port, retry and heartbeat constants and `gatewayHealthPath()` for the
//     daemon commands (serve, gateway, boot via ./boot-constants.ts, and the
//     gateway-* modules split out of gateway.ts);
//   - the ANSI colour object `c` for terminal output (doctor, listen, audit,
//     fallback, trace, run-all and gateway);
//   - `WARN_EXIT`, the exit code for "ran, but found something to warn about"
//     (doctor, listen, listen-preflight);
//   - `isOnPath(bin)`, the `which` probe `ethos doctor` and `ethos listen`
//     (listen-player) share.
// No module state: every export is a constant or a function. It imports
// `node:child_process` (for `isOnPath`), `node:path` and `@ethosagent/config`.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';

export const ACP_PORT_DEFAULT = 3001;
export const WEB_PORT_FALLBACK_ATTEMPTS = 5;
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Same cadence the gateway's `gateway-health.json` heartbeat uses for the
 *  call-capture ownership retry — do not invent a second interval. */
export const CALL_CAPTURE_HEARTBEAT_INTERVAL_MS = 10_000;

export function gatewayHealthPath(): string {
  return join(ethosDir(), 'gateway-health.json');
}

/** ANSI colour escapes the command's terminal output uses. */
export const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

/** Exit code a command returns when it ran but found something to warn about. */
export const WARN_EXIT = 2;

/** Is this binary runnable from here? The probe `ethos doctor` and
 *  `ethos listen` share. */
export function isOnPath(bin: string): boolean {
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
}
