import { splitList } from './utils';

/** Per-hook inbound webhook config (`webhooks.<hookId>.*` keys). */
export interface WebhookHookConfig {
  personalityId: string;
  secret: string;
  sessionKey?: string;
  /** Prefilter script (scripts-dir relative, .sh/.py) run with the raw
   *  request body on stdin before any turn is dispatched. */
  prefilter?: string;
  /** Wall-clock limit for the prefilter in seconds. Default 30, max 600. */
  prefilterTimeoutSeconds?: number;
  /** 'sync' (default) holds the connection for the agent's reply;
   *  'ack' responds 202 immediately and runs the turn detached. */
  mode?: 'sync' | 'ack';
  /** Accepted event names (comma-separated in the file). Absent accepts every
   *  request — the pre-existing behavior. */
  events?: string[];
  /** Request header carrying the event name. Default `'x-event-type'`.
   *  Requires `events`. */
  eventHeader?: string;
  /** Dotted path into the JSON body holding the event name, used when the
   *  header is absent. Default `'event'`; e.g. `'meta.event'`. Requires
   *  `events`. */
  eventField?: string;
  /** Relay the payload and dispatch no turn at all — the model is never
   *  involved, and the `prompt`/`text` body requirement does not apply.
   *  Requires at least one `deliver` target. */
  deliverOnly?: boolean;
  /** Extra destinations for this hook's content, fanned out alongside (never
   *  instead of) the HTTP response. Written as numbered keys:
   *  `webhooks.<id>.deliver.0.type` etc. */
  deliver?: WebhookDeliveryTargetConfig[];
  /** The operator vouches that only they can call this hook (plan
   *  personality-memory-boundary D12). A hook's turn runs private — with the
   *  personality's memory — only when this is `true` AND every `deliver`
   *  target is private (`webhookAudienceHint`, apps/ethos/src/webhook-server.ts);
   *  otherwise it runs shared. Only `true` is carried. */
  private?: boolean;
  /** Payload-integrity signing, ADDITIVE to the bearer `secret` and never a
   *  replacement for it: when set, both gates must pass. Written as nested
   *  keys: `webhooks.<id>.hmac.secret` etc. */
  hmac?: WebhookHmacConfig;
  /** Per-hook request throttle. Absent → unlimited, the pre-existing
   *  behavior. Written as nested keys: `webhooks.<id>.rateLimit.maxPerMinute`
   *  etc. */
  rateLimit?: WebhookRateLimitConfig;
}

/**
 * One `webhooks.<id>.rateLimit` block. The limiter it configures is
 * in-process — the gateway is a single-process model, so there is no shared
 * bucket to coordinate. The same knobs size two buckets: one per hookId, spent
 * only by callers that passed the bearer check, and one per (hookId, caller
 * address), spent only by bearer failures (`createWebhookServer`,
 * apps/ethos/src/webhook-server.ts).
 */
export interface WebhookRateLimitConfig {
  /** Requests allowed per minute. Also the bucket size. */
  maxPerMinute?: number;
  /** Lockout applied once the bucket empties. Default 600 (10 minutes). */
  lockoutSeconds?: number;
}

/**
 * One `webhooks.<id>.hmac` block. The signature is computed over the raw
 * request body and compared against `secret` — or `previousSecret`, which
 * exists so an operator can roll the sender's key without a synchronized
 * cutover.
 */
export interface WebhookHmacConfig {
  /** Shared signing secret. Externalized to the vault by the writer. */
  secret: string;
  /** Header carrying the bare hex signature. Default `'x-signature'`. */
  header?: string;
  /** Hash algorithm. Default `'sha256'`; see `WEBHOOK_HMAC_ALGORITHMS`. */
  algorithm?: string;
  /** Previous secret, still accepted during a rotation window. Externalized
   *  to the vault by the writer, exactly like `secret`. */
  previousSecret?: string;
}

/**
 * Algorithms an operator may name in `webhooks.<id>.hmac.algorithm`.
 *
 * Deliberately a short allowlist rather than a passthrough: the value reaches
 * `createHmac`, and an arbitrary operator string there is a footgun (a typo
 * throws at request time, and exotic OpenSSL digests are not something a
 * webhook sender emits). These three cover every signing scheme shipped by the
 * senders this feature exists for.
 */
export const WEBHOOK_HMAC_ALGORITHMS = ['sha256', 'sha1', 'sha512'] as const;

/**
 * One `webhooks.<id>.deliver.<n>` destination.
 *
 * - `log` — the process log. Carries no other field.
 * - `platform` — a live adapter, named by `adapterId` (exactly
 *   `PlatformAdapter.id`, e.g. `telegram:tg-a`), plus the `chatId` to send to
 *   and an optional `threadId` for a sub-conversation.
 */
export type WebhookDeliveryTargetConfig =
  | { type: 'log' }
  | { type: 'platform'; adapterId: string; chatId: string; threadId?: string };

/**
 * Group a hook's flat `deliver.<n>.<field>` keys into an ordered target list.
 *
 * The webhooks kv map stores whatever followed `webhooks.<id>.` as a literal
 * dotted key, so the numbered-array convention `telegram.bots.<n>.*` gets from
 * its own regex has to be reconstructed here. Indices are sorted numerically
 * (`sortedIndexes`'s reason: lexicographic order puts 10 before 2) and must be
 * a gapless 0..n-1 run — a gap means an operator deleted or mistyped a target
 * and should hear about it rather than have the list silently renumber.
 */
function buildWebhookDeliverTargets(
  entry: Record<string, string>,
  hookId: string,
): { targets: WebhookDeliveryTargetConfig[]; errors: string[] } {
  const errors: string[] = [];
  const byIndex = new Map<number, Record<string, string>>();
  for (const [key, value] of Object.entries(entry)) {
    const m = key.match(/^deliver\.([^.]+)\.(\S+)$/);
    if (!m) continue;
    const rawIndex = m[1] ?? '';
    const field = m[2] ?? '';
    if (!/^\d+$/.test(rawIndex)) {
      errors.push(
        `webhooks.${hookId}: deliver index '${rawIndex}' must be a non-negative integer.`,
      );
      continue;
    }
    const idx = Number(rawIndex);
    const bag = byIndex.get(idx) ?? {};
    bag[field] = value;
    byIndex.set(idx, bag);
  }
  if (errors.length > 0) return { targets: [], errors };
  const indexes = [...byIndex.keys()].sort((a, b) => a - b);
  const gapAt = indexes.findIndex((n, i) => n !== i);
  if (gapAt !== -1) {
    errors.push(
      `webhooks.${hookId}: deliver indexes must run 0..${indexes.length - 1} with no gaps ` +
        `(got ${indexes.join(', ')}).`,
    );
    return { targets: [], errors };
  }
  const targets: WebhookDeliveryTargetConfig[] = [];
  for (const idx of indexes) {
    const fields = byIndex.get(idx);
    if (!fields) continue;
    const label = `webhooks.${hookId}: deliver.${idx}`;
    const type = fields.type;
    if (type !== 'log' && type !== 'platform') {
      errors.push(
        `${label}.type must be 'log' or 'platform' ` +
          `(got ${type === undefined ? 'nothing' : `'${type}'`}).`,
      );
      continue;
    }
    if (type === 'log') {
      // A `log` target carries no destination. Silently ignoring a stray
      // adapterId/chatId would hide the far likelier reading: the operator
      // meant `type: platform` and this payload is going nowhere.
      const stray = (['adapterId', 'chatId', 'threadId'] as const).filter(
        (k) => fields[k] !== undefined,
      );
      if (stray.length > 0) {
        errors.push(`${label} is a 'log' target and must not set ${stray.join(', ')}.`);
        continue;
      }
      targets.push({ type: 'log' });
      continue;
    }
    const missing = (['adapterId', 'chatId'] as const).filter((k) => !fields[k]);
    if (missing.length > 0) {
      errors.push(`${label} is a 'platform' target and requires ${missing.join(', ')}.`);
      continue;
    }
    targets.push({
      type: 'platform',
      adapterId: fields.adapterId,
      chatId: fields.chatId,
      ...(fields.threadId ? { threadId: fields.threadId } : {}),
    });
  }
  return { targets, errors };
}

export function buildWebhooks(kv: Record<string, Record<string, string>>): {
  webhooks: Record<string, WebhookHookConfig> | undefined;
  errors: string[];
} {
  const ids = Object.keys(kv);
  if (ids.length === 0) return { webhooks: undefined, errors: [] };
  const webhooks: Record<string, WebhookHookConfig> = {};
  const errors: string[] = [];
  for (const hookId of ids) {
    const entry = kv[hookId];
    if (!entry) continue;
    if (!entry.personalityId) {
      errors.push(`webhooks.${hookId}: missing required field 'personalityId'.`);
      continue;
    }
    if (!entry.secret) {
      errors.push(`webhooks.${hookId}: missing required field 'secret'.`);
      continue;
    }
    if (entry.mode !== undefined && entry.mode !== 'sync' && entry.mode !== 'ack') {
      errors.push(`webhooks.${hookId}: mode must be 'sync' or 'ack'.`);
      continue;
    }
    let prefilterTimeoutSeconds: number | undefined;
    if (entry.prefilterTimeoutSeconds !== undefined) {
      if (!entry.prefilter) {
        errors.push(`webhooks.${hookId}: prefilterTimeoutSeconds requires 'prefilter'.`);
        continue;
      }
      const n = Number(entry.prefilterTimeoutSeconds);
      if (!Number.isInteger(n) || n < 1 || n > 600) {
        errors.push(
          `webhooks.${hookId}: prefilterTimeoutSeconds must be an integer between 1 and 600.`,
        );
        continue;
      }
      prefilterTimeoutSeconds = n;
    }
    const events = splitList(entry.events);
    if (entry.events !== undefined && events.length === 0) {
      errors.push(`webhooks.${hookId}: events must list at least one event name.`);
      continue;
    }
    if (entry.eventHeader !== undefined && events.length === 0) {
      errors.push(`webhooks.${hookId}: eventHeader requires 'events'.`);
      continue;
    }
    if (entry.eventField !== undefined && events.length === 0) {
      errors.push(`webhooks.${hookId}: eventField requires 'events'.`);
      continue;
    }
    let deliverOnly: boolean | undefined;
    if (entry.deliverOnly !== undefined) {
      if (entry.deliverOnly !== 'true' && entry.deliverOnly !== 'false') {
        errors.push(`webhooks.${hookId}: deliverOnly must be 'true' or 'false'.`);
        continue;
      }
      deliverOnly = entry.deliverOnly === 'true';
    }
    if (entry.private !== undefined && entry.private !== 'true' && entry.private !== 'false') {
      errors.push(`webhooks.${hookId}: private must be 'true' or 'false'.`);
      continue;
    }
    const isPrivate = entry.private === 'true';
    const deliverResult = buildWebhookDeliverTargets(entry, hookId);
    if (deliverResult.errors.length > 0) {
      errors.push(...deliverResult.errors);
      continue;
    }
    const deliver = deliverResult.targets;
    if (deliverOnly === true && deliver.length === 0) {
      // No turn AND no destination is a hook that accepts a payload and drops
      // it — never what the operator meant.
      errors.push(`webhooks.${hookId}: deliverOnly requires at least one 'deliver' target.`);
      continue;
    }
    // The webhooks kv map keys by whatever followed `webhooks.<id>.`, so the
    // nested-object convention (`telegram.bots.<n>.bind.type`) arrives here as
    // the literal keys 'hmac.secret', 'hmac.header', …
    const hmacSecret = entry['hmac.secret'];
    const hmacHeader = entry['hmac.header'];
    const hmacAlgorithm = entry['hmac.algorithm'];
    const hmacPreviousSecret = entry['hmac.previousSecret'];
    if (!hmacSecret && (hmacHeader || hmacAlgorithm || hmacPreviousSecret)) {
      errors.push(`webhooks.${hookId}: missing required field 'hmac.secret'.`);
      continue;
    }
    if (
      hmacAlgorithm !== undefined &&
      !WEBHOOK_HMAC_ALGORITHMS.includes(hmacAlgorithm as (typeof WEBHOOK_HMAC_ALGORITHMS)[number])
    ) {
      errors.push(
        `webhooks.${hookId}: hmac.algorithm must be one of ` +
          `${WEBHOOK_HMAC_ALGORITHMS.join(', ')}.`,
      );
      continue;
    }
    // Same nested-key convention as `hmac.*` above: the kv map keys by
    // whatever followed `webhooks.<id>.`, so these arrive as literal dotted
    // keys rather than a nested object.
    let rateLimit: WebhookRateLimitConfig | undefined;
    const rawMaxPerMinute = entry['rateLimit.maxPerMinute'];
    const rawLockoutSeconds = entry['rateLimit.lockoutSeconds'];
    if (rawLockoutSeconds !== undefined && rawMaxPerMinute === undefined) {
      errors.push(
        `webhooks.${hookId}: rateLimit.lockoutSeconds requires 'rateLimit.maxPerMinute'.`,
      );
      continue;
    }
    if (rawMaxPerMinute !== undefined) {
      const n = Number(rawMaxPerMinute);
      if (!Number.isInteger(n) || n < 1 || n > 100_000) {
        errors.push(
          `webhooks.${hookId}: rateLimit.maxPerMinute must be an integer between 1 and 100000.`,
        );
        continue;
      }
      let lockoutSeconds: number | undefined;
      if (rawLockoutSeconds !== undefined) {
        const l = Number(rawLockoutSeconds);
        if (!Number.isInteger(l) || l < 1 || l > 86_400) {
          errors.push(
            `webhooks.${hookId}: rateLimit.lockoutSeconds must be an integer between 1 and 86400.`,
          );
          continue;
        }
        lockoutSeconds = l;
      }
      rateLimit = {
        maxPerMinute: n,
        ...(lockoutSeconds !== undefined ? { lockoutSeconds } : {}),
      };
    }
    const hmac: WebhookHmacConfig | undefined = hmacSecret
      ? {
          secret: hmacSecret,
          ...(hmacHeader ? { header: hmacHeader } : {}),
          ...(hmacAlgorithm ? { algorithm: hmacAlgorithm } : {}),
          ...(hmacPreviousSecret ? { previousSecret: hmacPreviousSecret } : {}),
        }
      : undefined;
    webhooks[hookId] = {
      personalityId: entry.personalityId,
      secret: entry.secret,
      ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
      ...(entry.prefilter ? { prefilter: entry.prefilter } : {}),
      ...(prefilterTimeoutSeconds !== undefined ? { prefilterTimeoutSeconds } : {}),
      ...(entry.mode ? { mode: entry.mode } : {}),
      ...(events.length > 0 ? { events } : {}),
      ...(entry.eventHeader ? { eventHeader: entry.eventHeader } : {}),
      ...(entry.eventField ? { eventField: entry.eventField } : {}),
      // Only `true` is carried: `deliverOnly: false` and an absent key mean
      // exactly the same thing (dispatch a turn), so collapsing them keeps the
      // writer's output lossless without a presence/truthiness distinction the
      // field does not have.
      ...(deliverOnly === true ? { deliverOnly: true } : {}),
      // Same collapse as `deliverOnly`: absent and `false` both mean shared.
      ...(isPrivate ? { private: true } : {}),
      ...(deliver.length > 0 ? { deliver } : {}),
      ...(hmac ? { hmac } : {}),
      ...(rateLimit ? { rateLimit } : {}),
    };
  }
  return { webhooks: Object.keys(webhooks).length > 0 ? webhooks : undefined, errors };
}
