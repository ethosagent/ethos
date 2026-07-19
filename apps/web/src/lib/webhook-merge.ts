// Merge-on-save for the per-personality Triggers section (PersonalityDetail).
//
// `config.update`'s `webhooks` field is a FULL-replacement record across ALL
// personalities: entries absent from the record are deleted from config.yaml.
// The Triggers section edits only one personality's hooks, so it must carry
// every other personality's hooks through unchanged — and omitting their
// `secret` keeps each stored secret per the write-only contract.

/** One hook as returned by `config.get` (`webhooks.<hookId>.*`, secret redacted). */
export interface WebhookHookRead {
  personalityId: string;
  sessionKey: string | null;
  prefilter: string | null;
  prefilterTimeoutSeconds: number | null;
  mode: 'sync' | 'ack';
}

/** One editor row for a hook bound to the page's personality. */
export interface TriggerRowInput {
  hookId: string;
  /** New secret typed by the user; empty keeps the stored one (or lets the server generate). */
  secret: string;
  sessionKey: string;
  prefilter: string;
  prefilterTimeoutSeconds: number | null;
  mode: 'sync' | 'ack';
}

/** One hook as accepted by `config.update` (mirrors WebhookUpdateSchema). */
export interface WebhookHookPatch {
  personalityId: string;
  secret?: string;
  sessionKey?: string;
  prefilter?: string;
  prefilterTimeoutSeconds?: number;
  mode?: 'sync' | 'ack';
}

export type WebhookMergeResult =
  | { ok: true; webhooks: Record<string, WebhookHookPatch> }
  | { ok: false; error: string };

/** Mirrors ConfigRecordKeySchema in @ethosagent/web-contracts. */
const RECORD_KEY_RE = /^[A-Za-z0-9_-]+$/;

/** Carry one stored hook through a full-replacement save unchanged.
 *  No `secret` field — omitting it keeps the stored secret. */
function passthroughPatch(h: WebhookHookRead): WebhookHookPatch {
  return {
    personalityId: h.personalityId,
    mode: h.mode,
    ...(h.sessionKey ? { sessionKey: h.sessionKey } : {}),
    ...(h.prefilter ? { prefilter: h.prefilter } : {}),
    ...(h.prefilter && h.prefilterTimeoutSeconds !== null
      ? { prefilterTimeoutSeconds: h.prefilterTimeoutSeconds }
      : {}),
  };
}

/** Build the full `webhooks` record for `config.update` from one personality's
 *  edited rows: other personalities' hooks pass through untouched; this
 *  personality's hooks are replaced by `rows` (rows validated against the
 *  contract's bounds — key regex, secret length, timeout-requires-prefilter). */
export function mergeWebhooksForPersonality(
  existing: Record<string, WebhookHookRead>,
  personalityId: string,
  rows: TriggerRowInput[],
): WebhookMergeResult {
  const webhooks: Record<string, WebhookHookPatch> = {};
  for (const [hookId, h] of Object.entries(existing)) {
    if (h.personalityId === personalityId) continue;
    webhooks[hookId] = passthroughPatch(h);
  }

  for (const row of rows) {
    const hookId = row.hookId.trim();
    if (!RECORD_KEY_RE.test(hookId)) {
      return {
        ok: false,
        error: `Trigger id "${hookId}" must use only letters, digits, hyphens, or underscores.`,
      };
    }
    if (webhooks[hookId]) {
      const owner = existing[hookId]?.personalityId;
      return {
        ok: false,
        error:
          owner && owner !== personalityId
            ? `Trigger id "${hookId}" is already used by personality "${owner}".`
            : `Duplicate trigger id "${hookId}".`,
      };
    }
    if (row.secret && row.secret.length < 8) {
      return { ok: false, error: `Trigger "${hookId}": secret must be at least 8 characters.` };
    }
    const prefilter = row.prefilter.trim();
    if (row.prefilterTimeoutSeconds !== null && !prefilter) {
      return {
        ok: false,
        error: `Trigger "${hookId}": prefilter timeout requires a prefilter script.`,
      };
    }
    webhooks[hookId] = {
      personalityId,
      mode: row.mode,
      ...(row.secret ? { secret: row.secret } : {}),
      ...(row.sessionKey.trim() ? { sessionKey: row.sessionKey.trim() } : {}),
      ...(prefilter ? { prefilter } : {}),
      ...(prefilter && row.prefilterTimeoutSeconds !== null
        ? { prefilterTimeoutSeconds: row.prefilterTimeoutSeconds }
        : {}),
    };
  }

  return { ok: true, webhooks };
}
