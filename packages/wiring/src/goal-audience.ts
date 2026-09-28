// The room audience a goal's turns run under (plan
// personality-memory-boundary-and-self-amendment step 5). A goal has no stamp
// column (the plan's schema-impact list leaves `Goal` untouched); its audience
// is derived at run time from `Goal.origin`, which `goal_create`
// (@ethosagent/tools-goals) writes as the creating turn's `platform:chatId`, or
// `web`/`cli`. Pinned by `packages/wiring/src/__tests__/goal-audience.test.ts`.

import { type PrivateChatSet, targetAudience } from '@ethosagent/core';
import type { GoalOrigin, TurnAudience } from '@ethosagent/types';

/**
 * `'private'` for a goal created on the owner's own surfaces (`web`, `cli`);
 * for a channel origin (`platform:chatId`, split at the FIRST colon — a chat id
 * may contain more), the chat's `targetAudience` (packages/core/src/chat-audience.ts,
 * honouring `privateChats`), so a goal set in a group runs shared and one set
 * in a Discord or email DM, whose ids cannot be classified, fails closed.
 * Anything else → `'shared'`.
 *
 * Limitation: `goal_create` records `web` for a turn that carries no origin,
 * so a goal created by a turn with no channel origin — a delegated child of a
 * group turn, for one — reads as private here.
 */
export function goalRoomAudience(origin: GoalOrigin, privateChats?: PrivateChatSet): TurnAudience {
  if (origin === 'web' || origin === 'cli') return 'private';
  const colon = origin.indexOf(':');
  if (colon <= 0) return 'shared';
  return targetAudience(origin.slice(0, colon), origin.slice(colon + 1), privateChats);
}
