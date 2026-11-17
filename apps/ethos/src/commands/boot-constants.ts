// Constants and import-free helpers for `ethos boot` (./boot.ts), split out so
// boot.ts and its phase modules (./boot-reload.ts) share one copy. No module
// state: every export here is a constant or a pure function.

import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';

export const ACP_PORT_DEFAULT = 3001;
export const WEB_PORT_FALLBACK_ATTEMPTS = 5;
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Same cadence gateway.ts and serve.ts already use for the call-capture
 *  ownership retry — do not invent a second interval. */
export const CALL_CAPTURE_HEARTBEAT_INTERVAL_MS = 10_000;
/** How often `ethos boot` re-reads `~/.ethos/config.yaml` to diff it against
 *  the running config (plan/phases/gateway-live-reload.md §1, open question
 *  §7.1 — DECIDED: a dedicated constant, not `HEARTBEAT_INTERVAL_MS`). The two
 *  answer different questions — "is this process alive" vs "did the operator
 *  edit the file" — and sharing a constant would mean neither can move without
 *  the other. They happen to be equal today; that is a coincidence, not a
 *  contract. */
export const CONFIG_RELOAD_INTERVAL_MS = 10_000;
/** Same guard, same value, same reason as `REFRESH_DEBOUNCE_MS` in `runBoot`
 *  (./boot.ts): a reload triggered from more than one seam must not run twice
 *  in a burst. */
export const CONFIG_RELOAD_DEBOUNCE_MS = 300;

export const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

export function gatewayHealthPath(): string {
  return join(ethosDir(), 'gateway-health.json');
}
