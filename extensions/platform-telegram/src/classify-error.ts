// Classify Telegram Bot API failures (grammy) into actionable CHANNEL_CONFIG
// errors that name the platform, the cause, and the exact user fix. Anything
// unrecognized returns null — the caller keeps its existing error path.

import { channelConfigError, type EthosError } from '@ethosagent/types';

const PLATFORM = 'Telegram';

/**
 * Classify a thrown grammy/Bot API error. GrammyError carries `error_code`;
 * the message form ("Call to 'getMe' failed! (401: Unauthorized)") is matched
 * as a fallback for wrapped errors.
 */
export function classifyChannelError(err: unknown): EthosError | null {
  const errorCode =
    typeof err === 'object' && err !== null && 'error_code' in err
      ? Number((err as { error_code: unknown }).error_code)
      : undefined;
  const message = err instanceof Error ? err.message : String(err);

  if (errorCode === 401 || /\(401: Unauthorized\)|401: Unauthorized/i.test(message)) {
    return channelConfigError(
      PLATFORM,
      'Telegram rejected the bot token (401 Unauthorized).',
      'Open @BotFather in Telegram, run /token to regenerate the token, update it in ~/.ethos/config.yaml, then restart the gateway.',
    );
  }
  if (errorCode === 409 || /\(409: Conflict\)|409: Conflict/i.test(message)) {
    return channelConfigError(
      PLATFORM,
      'another process is already consuming this bot (409 Conflict) — a second gateway with the same token, or a webhook is set.',
      'Stop the other process using this bot token, or clear the webhook with https://api.telegram.org/bot<token>/deleteWebhook, then restart the gateway.',
    );
  }
  return null;
}
