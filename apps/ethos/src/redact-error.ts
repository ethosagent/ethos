// Redact secrets from provider/channel SDK error messages before they reach a
// log line. During `--from-env` the raw SDK error is printed next to a secret
// rotation: Google/Gemini errors echo the `?key=…` query param, openai-compat
// errors echo a base URL that can carry the key, and any SDK can spill a
// `Bearer …` header. A raw print lands the key in `docker compose` logs.
//
// Strategy: strip the KNOWN literal secret(s) we already hold, then run the
// shared secret-shape redactor for anything else that looks like a credential,
// then blanket-strip `Bearer …` / `?key=…` forms the shape redactor misses.

import { redactString } from '@ethosagent/safety-redact';

const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_QUERY = /([?&](?:key|api[_-]?key|access[_-]?token)=)[^&\s)"']+/gi;

/**
 * Return `message` with any occurrence of the supplied literal `secrets`
 * replaced, plus generic secret-shaped and `Bearer`/`?key=` patterns redacted.
 * Short/empty secrets are ignored so a stray 1-char value can't blank the text.
 */
export function redactErrorMessage(message: string, ...secrets: Array<string | undefined>): string {
  let out = message;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) {
      out = out.split(secret).join('[redacted]');
    }
  }
  out = redactString(out);
  out = out.replace(BEARER, 'Bearer [redacted]').replace(KEY_QUERY, '$1[redacted]');
  return out;
}
