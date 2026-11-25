import type { RoomPlatform } from '@ethosagent/web-contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import type { PreviewInput } from '../../rooms/room-rows';
import { type CallFilter, callsQueryInput } from '../../voice/call-rows';
import { startOfToday } from '../observed-rows';
import { callKeys, observedChatKeys, platformKeys, roomKeys } from './keys';

export function usePlatformsList() {
  return useQuery({
    queryKey: platformKeys.list(),
    queryFn: () => rpc.platforms.list(),
  });
}

export function useTelegramBots() {
  return useQuery({
    queryKey: platformKeys.bots('telegram'),
    queryFn: () => rpc.platforms.botsListTelegram(),
  });
}

export function useSlackBots() {
  return useQuery({
    queryKey: platformKeys.bots('slack'),
    queryFn: () => rpc.platforms.botsListSlack(),
  });
}

export function useWhatsAppBots() {
  return useQuery({
    queryKey: platformKeys.bots('whatsapp'),
    queryFn: () => rpc.platforms.botsListWhatsApp(),
  });
}

/** The plan's "times re-render every 30 s" (§8), done by refetching rather
 *  than by a second clock: the counts move too, and one interval that keeps
 *  both honest beats a ticking clock over stale numbers. React Query pauses an
 *  interval while the tab is unfocused, so a page left open costs nothing. */
export const OBSERVED_CHATS_POLL_MS = 30_000;

/**
 * Rooms a bot watches without answering.
 *
 * No error path: a deployment where nothing was ever observed answers
 * `{ lanes: [], omittedCount: 0, error: null }`, and an unreadable transcript
 * answers with `error` set — both are page CONTENT, not a rejected query. The
 * RPC does not throw on either, which is what lets the failure be a row that
 * stays instead of a toast that leaves (feedback & activity contract §6).
 */
export function useObservedChats(since: number = startOfToday()) {
  return useQuery({
    queryKey: observedChatKeys.since(since),
    queryFn: () => rpc.channels.observed({ since }),
    refetchInterval: OBSERVED_CHATS_POLL_MS,
  });
}

export function useChannelFilter(platform: string) {
  return useQuery({
    queryKey: platformKeys.channelFilter(platform),
    queryFn: () => rpc.platforms.getChannelFilter({ platform }),
  });
}

// -- Per-room policy (Communications > Rooms) -------------------------------

export function useRoomPolicies(platform: RoomPlatform) {
  return useQuery({
    queryKey: roomKeys.list(platform),
    queryFn: () => rpc.platforms.listRoomPolicies({ platform }),
  });
}

/** Ids, a DM flag and a time. No titles, no message text (backend §3.5). */
export function useRecentRooms(platform: RoomPlatform) {
  return useQuery({
    queryKey: roomKeys.recent(platform),
    queryFn: () => rpc.platforms.listRecentRooms({ platform }),
  });
}

/**
 * The gateway's own answer for the unsaved drawer form. A refusal (400/413)
 * rejects this query, and that is useful: it is the server's live "this would
 * not save" for the draft. `keepPreviousData` keeps the last good block on
 * screen while the next draft resolves, so typing does not flash the pane.
 */
export function useRoomPreview(input: PreviewInput | null) {
  return useQuery({
    queryKey: roomKeys.preview(input),
    queryFn: async () => {
      if (!input) throw new Error('no draft');
      return await rpc.platforms.previewRoomPolicy(input);
    },
    enabled: input !== null,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

/** Personalities bound to this platform's extra bots (Discord has no bot list). */
async function boundPersonalities(platform: RoomPlatform): Promise<string[]> {
  const res =
    platform === 'telegram'
      ? await rpc.platforms.botsListTelegram()
      : platform === 'slack'
        ? await rpc.platforms.botsListSlack()
        : platform === 'whatsapp'
          ? await rpc.platforms.botsListWhatsApp()
          : { bots: [] };
  const names = res.bots.flatMap((b) => (b.bind?.type === 'personality' ? [b.bind.name] : []));
  return [...new Set(names)];
}

/**
 * Skill ids the drawer offers: the global skills plus those of the personalities
 * bound to this platform's bots (a room's skills load through the bound
 * personality). Free entry stays allowed (the server warns). A failed bot or
 * personality lookup only narrows the suggestions; it never blocks the form.
 */
export function useRoomSkillOptions(platform: RoomPlatform) {
  return useQuery({
    queryKey: ['skills', 'roomOptions', platform],
    queryFn: async () => {
      const global = await rpc.skills.list({ includeUnavailable: true });
      const bound = await boundPersonalities(platform).catch(() => []);
      const lists = await Promise.allSettled(
        bound.map((personalityId) => rpc.personalities.skillsList({ personalityId })),
      );
      const ids = new Set(global.skills.map((s) => s.id));
      for (const l of lists) {
        if (l.status === 'fulfilled') for (const s of l.value.skills) ids.add(s.id);
      }
      return { ids: [...ids].sort() };
    },
    staleTime: 60_000,
  });
}

/** Registry aliases for the model select. Same key as the personality picker
 *  (`MODEL_REGISTRY_LIST_KEY`), so a registry write refreshes both. */
export function useRoomModelAliases() {
  return useQuery({
    queryKey: ['modelRegistry', 'list'],
    queryFn: () => rpc.modelRegistry.list(),
    staleTime: 60_000,
  });
}

// -- Telephony call history (voice V4) --------------------------------------
//
// A deployment with no call log answers `{ calls: [] }` rather than throwing,
// so none of these hooks needs an error path for "telephony is not configured"
// — that case IS the empty state.

/** Live enough that a call ringing right now appears without a reload, slow
 *  enough that a Communications tab left open is not a load generator. React
 *  Query pauses an interval while the tab is unfocused, so a hidden tab polls
 *  nothing. */
export const ACTIVE_CALLS_POLL_MS = 4_000;

export function useCallsList(filter: CallFilter) {
  return useQuery({
    queryKey: callKeys.list(filter),
    queryFn: () => rpc.voice.calls.list(callsQueryInput(filter)),
  });
}

export function useActiveCalls() {
  return useQuery({
    queryKey: callKeys.active(),
    queryFn: () => rpc.voice.calls.active(),
    refetchInterval: ACTIVE_CALLS_POLL_MS,
  });
}

/** Null id = no row is open, so nothing is fetched. The transcript is the one
 *  thing the list deliberately withholds; it arrives only when asked for. */
export function useCallDetail(id: string | null) {
  return useQuery({
    queryKey: callKeys.detail(id ?? ''),
    queryFn: () => rpc.voice.calls.get({ id: id ?? '' }),
    enabled: id !== null,
  });
}
