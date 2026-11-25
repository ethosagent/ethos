// `/budget` gateway command, moved out of index.ts (size limit). Pure code move.

import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import type { BotSpend, GatewayBotConfig } from './gateway-config';

/** What `handleBudgetCommand` needs from `Gateway`, resolved for one message. */
export interface BudgetDeps {
  /** The lane's CURRENT session key (`sessionKeys.get(laneKey) ?? laneKey`). */
  readonly sessionKey: string;
  /** `channel_filter.<platform>.ownerUserId` for the message's platform. */
  readonly ownerUserId: string | undefined;
  /** Whether the message's sender is the owner (`Gateway.isOwner`). */
  readonly isOwner: boolean;
  /** The lane's personality, or undefined for a team bot. */
  readonly personalityId: string | undefined;
  readonly spentToday: () => Promise<BotSpend | null>;
}

/**
 * `/budget` and `/budget reset` (plan openclaw-2026.9.6-gaps S4/U1) — the
 * channel half of the CLI command, over the same `AgentLoop` session-cost
 * counter `budgetCapUsd` is checked against (`getSessionCost` /
 * `resetSessionCost`), keyed by the lane's CURRENT session key.
 *
 * The reset is lane-wide state, so it takes `/personality`'s group rule
 * (plan openclaw-advisory-fixes D20/D21): in a group only the configured
 * `channel_filter.<platform>.ownerUserId` may reset, and a group on a
 * platform with no owner refuses outright. The read-only form stays open.
 * Pinned by `__tests__/budget-halt.test.ts`.
 */
export async function handleBudgetCommand(
  deps: BudgetDeps,
  text: string,
  bot: GatewayBotConfig,
  message: InboundMessage,
  adapter: PlatformAdapter,
  threadId: string | undefined,
): Promise<void> {
  const reply = (body: string) =>
    adapter.send(message.chatId, { text: body, threadId }).catch(() => {});
  const { sessionKey } = deps;
  const arg = text.split(/\s+/)[1]?.toLowerCase() ?? '';

  if (arg === 'reset') {
    if (!message.isDm && !deps.isOwner) {
      await reply(
        deps.ownerUserId === undefined
          ? `Resetting the budget in a group needs an owner. ` +
              `Set channel_filter.${message.platform}.ownerUserId in config.yaml.`
          : 'Only the bot owner can reset the budget in a group.',
      );
      return;
    }
    bot.loop.resetSessionCost(sessionKey);
    await reply('✓ Budget counter reset for this session.');
    return;
  }

  const spent = bot.loop.getSessionCost(sessionKey);
  const cap = bot.loop.getPersonalityBudgetCap(deps.personalityId);
  const today = await deps.spentToday();
  await reply(
    `Session spend: $${spent.toFixed(4)}` +
      (cap != null ? ` of a $${cap.toFixed(2)} cap` : ' (no session cap set)') +
      (today !== null && bot.budget
        ? `\nBot spend today (UTC): $${(today.repliesUsd + today.backgroundUsd).toFixed(4)} ` +
          `of a $${bot.budget.dailyUsd.toFixed(2)} daily cap ` +
          `($${today.repliesUsd.toFixed(4)} replies, $${today.backgroundUsd.toFixed(4)} background)`
        : '') +
      `\nUse /budget reset to start a new budget window.`,
  );
}
