// Room metadata for the room prompt's untrusted block (plan channel-prompts
// L7, D14). Topic and purpose are member-editable, so they are UNTRUSTED data:
// this module only fetches them. The gateway wraps, caps and scans them.

import type { Logger } from '@ethosagent/types';

export interface SlackRoomMetadata {
  topic?: string;
  purpose?: string;
  name?: string;
}

export const ROOM_METADATA_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED = 1000;
/** How long a message waits for a cold `conversations.info` before it is delivered without metadata. */
export const ROOM_METADATA_WAIT_MS = 2000;

interface ConversationsInfoClient {
  conversations: {
    info(args: { channel: string }): Promise<{
      channel?: {
        name?: string;
        topic?: { value?: string };
        purpose?: { value?: string };
      };
    }>;
  };
}

/**
 * `conversations.info` with a 1 h per-channel cache. A failure (`missing_scope`
 * when the app lacks `channels:read`/`groups:read`, a network blip) is logged
 * once per cache window and cached as "no metadata": the turn proceeds without
 * it and Slack is not hammered on every message. A cold cache shares ONE
 * in-flight call per channel (concurrent messages do not each call Slack), and
 * a caller waits at most `waitMs` for it: past that it gets `undefined` (the
 * message goes on without metadata) while the call still finishes and fills the
 * cache. Pinned by 'cold cache' in `__tests__/room-metadata.test.ts`.
 */
export function createSlackRoomMetadata(
  client: ConversationsInfoClient,
  logger: Logger,
  now: () => number = Date.now,
  waitMs: number = ROOM_METADATA_WAIT_MS,
): (channelId: string) => Promise<SlackRoomMetadata | undefined> {
  const cache = new Map<string, { at: number; value: SlackRoomMetadata | undefined }>();
  const inFlight = new Map<string, Promise<SlackRoomMetadata | undefined>>();
  const fetchOnce = async (channelId: string): Promise<SlackRoomMetadata | undefined> => {
    let value: SlackRoomMetadata | undefined;
    try {
      const res = await client.conversations.info({ channel: channelId });
      const ch = res.channel;
      const topic = ch?.topic?.value?.trim();
      const purpose = ch?.purpose?.value?.trim();
      const name = ch?.name?.trim();
      const meta: SlackRoomMetadata = {
        ...(topic ? { topic } : {}),
        ...(purpose ? { purpose } : {}),
        ...(name ? { name } : {}),
      };
      value = Object.keys(meta).length > 0 ? meta : undefined;
    } catch (err) {
      const code = (err as { data?: { error?: string } }).data?.error;
      logger.warn(
        code === 'missing_scope'
          ? 'Slack fetch_metadata: conversations.info needs channels:read / groups:read; room metadata skipped'
          : `Slack fetch_metadata: conversations.info failed (${code ?? (err instanceof Error ? err.message : 'unknown')}); room metadata skipped`,
        { channel: channelId },
      );
      value = undefined;
    }
    cache.delete(channelId);
    cache.set(channelId, { at: now(), value });
    if (cache.size > MAX_CACHED) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    return value;
  };
  return async (channelId) => {
    const hit = cache.get(channelId);
    if (hit && now() - hit.at < ROOM_METADATA_TTL_MS) return hit.value;
    let pending = inFlight.get(channelId);
    if (!pending) {
      pending = fetchOnce(channelId).finally(() => inFlight.delete(channelId));
      inFlight.set(channelId, pending);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), waitMs);
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Runs `step`s that share a key strictly one after another, in call order; steps
 * under different keys do not wait on each other. A throwing step does not break
 * the chain. The Slack adapter keys on channel so a slow `conversations.info`
 * for one message cannot let the next message overtake it.
 */
export function createKeyedChain(): (key: string, step: () => Promise<void>) => void {
  const tails = new Map<string, Promise<void>>();
  return (key, step) => {
    const next: Promise<void> = (tails.get(key) ?? Promise.resolve())
      .then(step)
      .catch(() => {})
      .finally(() => {
        if (tails.get(key) === next) tails.delete(key);
      });
    tails.set(key, next);
  };
}
