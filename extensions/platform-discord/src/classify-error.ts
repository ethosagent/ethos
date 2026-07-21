// Classify discord.js startup/auth failures into actionable CHANNEL_CONFIG
// errors that name the platform, the cause, and the exact user fix. Anything
// unrecognized returns null — the caller keeps its existing error path.

import { channelConfigError, type EthosError } from '@ethosagent/types';

const PLATFORM = 'Discord';

const DISALLOWED_INTENTS_REASON =
  'this bot does not have the Message Content privileged intent enabled, so Discord refused the connection (close code 4014).';
const DISALLOWED_INTENTS_ACTION =
  "Discord Developer Portal > your app > Bot > Privileged Gateway Intents > enable 'Message Content Intent', then restart the gateway.";

const TOKEN_INVALID_REASON = 'Discord rejected the bot token as invalid.';
const TOKEN_INVALID_ACTION =
  'Discord Developer Portal > your app > Bot > Reset Token, then update the discord token in ~/.ethos/config.yaml and restart the gateway.';

/**
 * Map a fatal Discord gateway close code to a classified error.
 * 4004 = authentication failed (bad token); 4013/4014 = invalid/disallowed
 * intents. Other close codes are recoverable (discord.js reconnects) → null.
 */
export function classifyDiscordCloseCode(code: number): EthosError | null {
  if (code === 4004) {
    return channelConfigError(PLATFORM, TOKEN_INVALID_REASON, TOKEN_INVALID_ACTION);
  }
  if (code === 4013 || code === 4014) {
    return channelConfigError(PLATFORM, DISALLOWED_INTENTS_REASON, DISALLOWED_INTENTS_ACTION);
  }
  return null;
}

/**
 * Classify a thrown discord.js error (login rejection or late WS failure).
 * Matches both the DiscordjsError codes ('DisallowedIntents', 'TokenInvalid')
 * and the raw WS close-reason strings Discord sends ('Used disallowed
 * intents', 'An invalid token was provided.').
 */
export function classifyChannelError(err: unknown): EthosError | null {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';
  const message = err instanceof Error ? err.message : String(err);

  if (code === 'DisallowedIntents' || /disallowed intents|privileged intent/i.test(message)) {
    return channelConfigError(PLATFORM, DISALLOWED_INTENTS_REASON, DISALLOWED_INTENTS_ACTION);
  }
  if (code === 'TokenInvalid' || /invalid token|authentication failed/i.test(message)) {
    return channelConfigError(PLATFORM, TOKEN_INVALID_REASON, TOKEN_INVALID_ACTION);
  }
  return null;
}
