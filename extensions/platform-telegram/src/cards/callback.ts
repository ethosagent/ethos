// `rca:<token>:<index>` — the callback_data of a `recommend_actions` button (plan
// telegram-live-cards). Telegram caps callback_data at 64 bytes and a prompt may run to 500 chars,
// so the prompt never rides the button: the token keys `CardActionStore`
// (`store/card-actions.ts`), which holds it.

export const CARD_ACTION_PREFIX = 'rca';

/** Characters of a card token: RFC 4648 base32, so a token is safe in callback_data and a file. */
export const CARD_TOKEN_LENGTH = 10;

/** The callback_data for button `index` of the card keyed by `token`. */
export function cardCallbackData(token: string, index: number): string {
  return `${CARD_ACTION_PREFIX}:${token}:${index}`;
}

/** Parse `rca:<token>:<index>`. Null for anything else; a malformed payload is answered, never thrown. */
export function parseCardCallback(data: string): { token: string; index: number } | null {
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== CARD_ACTION_PREFIX) return null;
  const [, token, rawIndex] = parts;
  if (!token || !/^[A-Z2-7]+$/.test(token) || token.length > 32) return null;
  if (!rawIndex || !/^\d{1,2}$/.test(rawIndex)) return null;
  return { token, index: Number(rawIndex) };
}
