// Discord error classification, moved out of `index.ts` (size refactor; no behaviour change).

/**
 * Discord JSON error codes no retry can fix: Unknown Channel, Missing Access,
 * Cannot send messages to this user, Missing Permissions.
 */
const PERMANENT_DISCORD_CODES = new Set([10003, 50001, 50007, 50013]);

/**
 * Does `err` (a discord.js `DiscordAPIError`, read by shape) say the bot can
 * never post here — until an operator changes something? HTTP 403/404 or one
 * of {@link PERMANENT_DISCORD_CODES}. Rate limits (429) and server errors are
 * not: discord.js retries 429s itself and a 5xx is transient.
 */
export function isPermanentDiscordError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = 'status' in err ? err.status : undefined;
  const code = 'code' in err ? err.code : undefined;
  if (status === 403 || status === 404) return true;
  return typeof code === 'number' && PERMANENT_DISCORD_CODES.has(code);
}

/**
 * discord.js error codes `client.login()` raises when the credentials or the
 * application settings are wrong — a revoked or mistyped token, or a
 * privileged intent the Developer Portal has not enabled. No retry fixes
 * either; an operator has to.
 */
const PERMANENT_DISCORD_LOGIN_CODES = new Set([
  'TokenInvalid',
  'TokenMissing',
  'DisallowedIntents',
]);

/**
 * `err` re-thrown carrying `permanent: true` when it is a login failure no
 * retry can fix (a {@link PERMANENT_DISCORD_LOGIN_CODES} code, or an HTTP 401),
 * so the gateway's adapter-start retry (`isPermanentAdapterStartError`,
 * apps/ethos/src/commands/gateway-adapters.ts) gives up instead of retrying a dead
 * token for ever. Anything else is returned unchanged.
 */
export function classifyDiscordStartError(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) return err;
  const code = 'code' in err ? err.code : undefined;
  const status = 'status' in err ? err.status : undefined;
  const permanent =
    (typeof code === 'string' && PERMANENT_DISCORD_LOGIN_CODES.has(code)) || status === 401;
  if (!permanent) return err;
  const detail = err instanceof Error ? err.message : String(code ?? status);
  return Object.assign(new Error(`Discord refused the bot login: ${detail}`, { cause: err }), {
    permanent: true,
  });
}
