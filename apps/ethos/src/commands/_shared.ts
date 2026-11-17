// Constants and import-free helpers that `ethos serve`, `ethos gateway` and
// `ethos boot` (./serve.ts, ./gateway.ts, ./boot-constants.ts) each used to
// declare for themselves, split out so the three share one copy. No module
// state: every export here is a constant or a pure function.

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
