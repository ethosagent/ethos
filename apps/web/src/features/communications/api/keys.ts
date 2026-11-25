export const platformKeys = {
  all: () => ['platforms'] as const,
  list: () => [...platformKeys.all(), 'list'] as const,
  bots: (platform: string) => [...platformKeys.all(), 'bots', platform] as const,
  channelFilter: (platform: string) => [...platformKeys.all(), 'channelFilter', platform] as const,
};

/** Rooms a bot watches without answering (observe mode). The `since` window is
 *  part of the key: "today" moves at local midnight, and a stale cache entry
 *  would keep counting yesterday's messages as today's. */
export const observedChatKeys = {
  all: () => ['channels', 'observed'] as const,
  since: (since: number) => [...observedChatKeys.all(), since] as const,
};

/** Telephony call history (voice V4). The filter is part of the LIST key, so
 *  flipping a chip is a different cache entry rather than a refetch that
 *  overwrites the unfiltered history — going back to "All" is then instant and
 *  shows what it showed before. */
export const callKeys = {
  all: () => ['voice', 'calls'] as const,
  list: (filter: { direction: string; status: string }) =>
    [...callKeys.all(), 'list', filter.direction, filter.status] as const,
  active: () => [...callKeys.all(), 'active'] as const,
  detail: (id: string) => [...callKeys.all(), 'detail', id] as const,
};

/** Per-room policy (Communications > Rooms). The preview input is part of the
 *  key, so each draft the operator types is its own cache entry and a slow
 *  answer for an older draft can never overwrite the newer one's. */
export const roomKeys = {
  all: () => ['rooms'] as const,
  list: (platform: string) => [...roomKeys.all(), 'list', platform] as const,
  recent: (platform: string) => [...roomKeys.all(), 'recent', platform] as const,
  preview: (input: unknown) => [...roomKeys.all(), 'preview', JSON.stringify(input)] as const,
};
