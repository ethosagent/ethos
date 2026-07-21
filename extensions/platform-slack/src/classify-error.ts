// Classify Slack (Bolt / Web API / Socket Mode) failures into actionable
// CHANNEL_CONFIG errors that name the platform, the cause, and the exact user
// fix. Anything unrecognized returns null — the caller keeps its existing
// error path.

import { channelConfigError, type EthosError } from '@ethosagent/types';

const PLATFORM = 'Slack';

/** Pull the Slack API error string (`invalid_auth`, `missing_scope`, …) out of
 *  a Bolt/Web API error shape, or from the message text as a fallback. */
function slackApiError(err: unknown): { apiError: string; needed?: string } | null {
  if (typeof err === 'object' && err !== null && 'data' in err) {
    const data = (err as { data: unknown }).data;
    if (typeof data === 'object' && data !== null && 'error' in data) {
      const apiError = String((data as { error: unknown }).error);
      const needed = 'needed' in data ? String((data as { needed: unknown }).needed) : undefined;
      return needed !== undefined ? { apiError, needed } : { apiError };
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(
    /\b(invalid_auth|not_authed|account_inactive|token_revoked|missing_scope|invalid_app_token)\b/,
  );
  return match ? { apiError: match[1] } : null;
}

export function classifyChannelError(err: unknown): EthosError | null {
  const found = slackApiError(err);
  if (!found) return null;
  const { apiError, needed } = found;

  if (apiError === 'invalid_auth' || apiError === 'not_authed' || apiError === 'token_revoked') {
    return channelConfigError(
      PLATFORM,
      `Slack rejected the bot token (${apiError}).`,
      'Slack app settings (api.slack.com/apps) > OAuth & Permissions > reinstall the app or copy the current Bot User OAuth Token (xoxb-...), update ~/.ethos/config.yaml, then restart the gateway.',
    );
  }
  if (apiError === 'account_inactive') {
    return channelConfigError(
      PLATFORM,
      'the Slack app or workspace account behind this token is deactivated (account_inactive).',
      'Reinstall the app to the workspace from api.slack.com/apps, update the tokens in ~/.ethos/config.yaml, then restart the gateway.',
    );
  }
  if (apiError === 'missing_scope') {
    const scope = needed ? ` Add the '${needed}' scope.` : '';
    return channelConfigError(
      PLATFORM,
      `the bot token is missing a required OAuth scope (missing_scope).${scope}`,
      'Slack app settings > OAuth & Permissions > Scopes > add the missing bot scope, reinstall the app, update the token, then restart the gateway.',
    );
  }
  if (apiError === 'invalid_app_token') {
    // Socket mode needs an app-level token, not a bot token.
    return channelConfigError(
      PLATFORM,
      'the app-level token for Socket Mode is invalid (invalid_app_token).',
      'Slack app settings > Basic Information > App-Level Tokens > create a token with the connections:write scope (xapp-...), set it as the Slack app token in ~/.ethos/config.yaml, then restart the gateway.',
    );
  }
  // Any other Slack API error (ratelimited, fatal_error, …) is not a
  // configuration problem — keep the caller's existing error path.
  return null;
}
