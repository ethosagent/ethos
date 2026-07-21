// Classify WhatsApp (Baileys) failures into actionable CHANNEL_CONFIG errors
// that name the platform, the cause, and the exact user fix. Anything
// unrecognized returns null — the caller keeps its existing error path.

import { channelConfigError, type EthosError } from '@ethosagent/types';

const PLATFORM = 'WhatsApp';

/** Baileys DisconnectReason.loggedOut — the linked device was unpaired. */
const LOGGED_OUT_STATUS = 401;

/** Build the classified error for a logged-out WhatsApp session. */
export function loggedOutError(sessionDir: string): EthosError {
  return channelConfigError(
    PLATFORM,
    'this device link was logged out — WhatsApp no longer accepts the stored session credentials.',
    `Delete the session directory (${sessionDir}), restart the gateway, and relink the device via the QR code or pairing code.`,
  );
}

/**
 * Classify a Baileys disconnect/connection error. Baileys wraps failures in
 * Boom errors with `output.statusCode`; 401 means the device link was logged
 * out (permanent until the user relinks).
 */
export function classifyChannelError(
  err: unknown,
  sessionDir = '~/.ethos/whatsapp',
): EthosError | null {
  const statusCode =
    typeof err === 'object' && err !== null && 'output' in err
      ? Number((err as { output: { statusCode?: unknown } }).output?.statusCode)
      : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (statusCode === LOGGED_OUT_STATUS || /logged out/i.test(message)) {
    return loggedOutError(sessionDir);
  }
  return null;
}
