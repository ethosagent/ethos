import { MAX_TOKENS_REPLY_NOTICE } from '@ethosagent/core';

// Per-room silence predicates and the private-DM gate (plan channel-prompts L11, D17, D20).
// Split out of gateway-pure.ts to keep it under the source-size limit.

/**
 * A PRIVATE DM: one person on the other end. A DM an adapter hints `shared`
 * (a Discord group DM, a WhatsApp broadcast or newsletter) is `isDm: true` yet
 * has several readers, so it is not private. The single predicate for gating
 * operator-only output (`/channel show`); pinned by
 * `__tests__/channel-command.test.ts` ('shared DM').
 */
export function isPrivateDm(message: { isDm: boolean; audienceHint?: string }): boolean {
  return message.isDm && message.audienceHint !== 'shared';
}

/**
 * The exact replies that mean "send nothing" in a room that set `silent: true`
 * (plan channel-prompts L11, D20). `NO_REPLY` is the one the room prompt names
 * (`ROOM_SILENT_LINE`); `[SILENT]` is the Hermes spelling, honoured for parity.
 */
export const SILENT_REPLY_MARKERS: readonly string[] = ['NO_REPLY', '[SILENT]'];

/**
 * True when `text`, trimmed, IS a silence marker. Exact and case-sensitive:
 * `NO_REPLY.`, `no_reply` and `Sure. NO_REPLY` are ordinary replies.
 */
export function isSilentMarker(text: string): boolean {
  return SILENT_REPLY_MARKERS.includes(text.trim());
}

/**
 * True while a growing reply could still END UP a silence marker: trimmed, it
 * is a prefix of one (the empty string included). The live draft is held while
 * this holds on a silent lane (`DraftStreamer.maybeFlush`), so `NO_` is never
 * on screen. Text only grows, so once this is false it stays false.
 */
export function couldBecomeSilentMarker(prefix: string): boolean {
  const t = prefix.trim();
  return SILENT_REPLY_MARKERS.some((m) => m.startsWith(t));
}

/**
 * The one decision for per-room silence (plan channel-prompts D20): a reply is
 * dropped only when the ROOM opted in (`silent: true`, read from operator
 * config by `resolveRoomPolicy`) AND the whole reply is a marker. A model
 * cannot silence a room that did not opt in. Called from `Gateway.runTurn`
 * (`deliverAnswer`); pinned by `__tests__/room-silence.test.ts`.
 */
export function shouldSuppressSilentReply(roomSilent: boolean, replyText: string): boolean {
  return roomSilent === true && isSilentMarker(replyText);
}

/**
 * The reply text before any halt notice. A silent room whose answer is exactly
 * a marker but which has a halt or output-cap notice to deliver sends the
 * notice alone: the literal marker is never shown. With no notice the marker
 * stays, so `shouldSuppressSilentReply` sees it. A cut-off non-blank reply ends
 * with `MAX_TOKENS_REPLY_NOTICE` (V-CP-2 / UBP-033). Pinned by 'marker plus a
 * notice' in room-silence.test.ts.
 */
export function answerWithCapNotice(
  roomSilent: boolean,
  answer: string,
  cutOffAtCap: boolean,
  halted: boolean,
): string {
  const capNotice = cutOffAtCap && answer.trim().length > 0;
  const body = roomSilent && (capNotice || halted) && isSilentMarker(answer) ? '' : answer;
  if (!capNotice) return body;
  return body ? `${body}\n\n${MAX_TOKENS_REPLY_NOTICE}` : MAX_TOKENS_REPLY_NOTICE;
}
