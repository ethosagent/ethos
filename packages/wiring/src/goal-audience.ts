// The room audience a goal's turns run under (plan
// personality-memory-boundary-and-self-amendment step 5). A goal has no stamp
// column (the plan's schema-impact list leaves `Goal` untouched); its audience
// is derived at run time from `Goal.origin`, which `goal_create`
// (@ethosagent/tools-goals) writes as the creating turn's `platform:chatId`, or
// `web`/`cli`. Pinned by `packages/wiring/src/__tests__/goal-audience.test.ts`.

import { type PrivateChatSet, targetAudience } from '@ethosagent/core';
import { CHANNEL_EXCLUDED_TOOLS } from '@ethosagent/gateway';
import type { GoalOrigin, TurnAudience } from '@ethosagent/types';

/**
 * `'private'` for a goal created on the owner's own surfaces (`web`, `cli`);
 * for a channel origin (`platform:chatId`, split at the FIRST colon — a chat id
 * may contain more), the chat's `targetAudience` (packages/core/src/chat-audience.ts,
 * honouring `privateChats`), so a goal set in a group runs shared and one set
 * in a Discord or email DM, whose ids cannot be classified, fails closed.
 * Anything else → `'shared'`.
 *
 * `goal_create` records `web` for a turn that carries no origin, which reads as
 * private here — so it refuses a shared turn whose origin does not derive
 * shared through this same function (bound in compose-tools.ts,
 * `createGoalTools`'s `originAudience`); a delegated child of a group turn
 * cannot create a goal that would run private. Pinned by
 * extensions/tools-goals/src/__tests__/goal-audience.test.ts.
 */
export function goalRoomAudience(origin: GoalOrigin, privateChats?: PrivateChatSet): TurnAudience {
  if (origin === 'web' || origin === 'cli') return 'private';
  const colon = origin.indexOf(':');
  if (colon <= 0) return 'shared';
  return targetAudience(origin.slice(0, colon), origin.slice(colon + 1), privateChats);
}

/**
 * The tools a goal run must not be offered for its origin: the UI card tools when the origin is a
 * channel (`platform:chatId`). A goal run has no viewer for a card, and a channel origin is what
 * `surfaceOf` (extensions/tools-ui/src/ui-platform.ts) reads to let `emit_card` through, so a run
 * site that forwards a channel origin to `AgentLoop.run` passes this as `toolsetExclude`.
 * `undefined` for `web`, `cli` or no origin. Pinned by `__tests__/goal-audience.test.ts`.
 */
export function goalToolsetExclude(origin: GoalOrigin | undefined): string[] | undefined {
  if (origin === undefined || origin === 'web' || origin === 'cli') return undefined;
  return origin.indexOf(':') > 0 ? [...CHANNEL_EXCLUDED_TOOLS] : undefined;
}
