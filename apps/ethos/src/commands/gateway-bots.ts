// `ethos gateway start` — bot assembly's shapes and the bot-key / MCP-login
// helpers that depend on nothing in the gateway command. Split out of
// gateway.ts, which still builds the bots (`buildGatewayBots`,
// `assembleGatewayBots`) and re-exports everything here.

import { join } from 'node:path';
import { ethosDir, type WhatsAppConfig } from '@ethosagent/config';
import type { GatewayBotConfig } from '@ethosagent/gateway';
import { ConsoleLogger } from '@ethosagent/logger';
import type { NotificationRouter, ToolRegistry } from '@ethosagent/types';
import { createMcpLoginPort, type MessagingSendFn } from '@ethosagent/wiring';
import { type createAgentLoop, getSecretsResolver, getStorage } from '../wiring';

/**
 * One bot's share of the flat lists on {@link BuildGatewayBotsResult}.
 *
 * The flat lists are what a caller registers; this is what it needs to
 * DEREGISTER exactly one bot again. A caller that only ever tears the whole
 * process down can ignore it — `ethos boot`'s live reconciler cannot, because
 * replacing one bot has to undo that bot's registrations and no others
 * (plan/phases/gateway-live-reload.md §2).
 */
export interface GatewayBotWiring {
  messagingSetters: Array<(fn: MessagingSendFn) => void>;
  notificationRouters: NotificationRouter[];
  toolRegistries: ToolRegistry[];
  refreshers: Array<() => Promise<void>>;
  /** The bot's loop runtime release (`CreateAgentLoopResult.dispose`, F06). */
  disposers: Array<() => Promise<void>>;
}

export interface BuildGatewayBotsResult {
  bots: GatewayBotConfig[];
  messagingSetters: Array<(fn: MessagingSendFn) => void>;
  /** One NotificationRouter per bot loop — `process_complete` hooks fire on
   *  the owning loop's router, so the Gateway must register its per-session
   *  adapter on every one of them. */
  notificationRouters: NotificationRouter[];
  /** One ToolRegistry per bot loop. Each loop owns its own registry (there is
   *  no shared one), so the outbound `a2a_send` tool is registered on every one
   *  of them — see `registerA2aOutboundTools`. */
  toolRegistries: ToolRegistry[];
  /** One `refreshPersonalities` closure per personality-bound bot loop. The
   *  gateway's `personalityDirectory.refresh()` invokes all of them so a
   *  hot-dropped/edited personality reaches every loop's registry. Team loops
   *  have no personality registry and contribute none. */
  refreshers: Array<() => Promise<void>>;
  /** One runtime release per bot loop (`CreateAgentLoopResult.dispose`, F06) —
   *  what a stopping gateway, or a bot retired live, calls once nothing routes
   *  to the loop any more. */
  disposers: Array<() => Promise<void>>;
  /** The lists above, attributed to the bot that produced each entry.
   *  Aligned with `bots` — same order, same membership. */
  perBot: Map<string, GatewayBotWiring>;
}

/**
 * Derive the botKey for a WhatsApp config. MUST stay byte-identical to the
 * adapter's own fallback (`WhatsAppAdapter` in @ethosagent/platform-whatsapp)
 * so the key the gateway routes table is built from matches the key the
 * adapter stamps on inbound messages. WhatsApp has no token, so unlike
 * telegram/slack there is nothing to sha256 — the key is the explicit `id`
 * or a slug of the session directory.
 */
export function whatsAppBotKey(waCfg: WhatsAppConfig): string {
  return (
    waCfg.id ??
    `wa-${(waCfg.session_dir ?? join(ethosDir(), 'whatsapp')).replace(/[^a-zA-Z0-9]/g, '').slice(-16)}`
  );
}

/**
 * Build one personality bot's `/mcp login` port (plan mcp-device-code-login
 * §8.2): tokens are scoped to the lane personality and reconnected on THIS
 * bot's McpManager. Its `dispose` joins the bot's disposers, so a retired bot
 * or a stopping gateway aborts the pending flows. Team bots get none.
 */
export async function attachMcpLogin(
  result: Pick<Awaited<ReturnType<typeof createAgentLoop>>, 'mcpManager' | 'personalities'>,
  disposers: Array<() => Promise<void>>,
): Promise<NonNullable<GatewayBotConfig['mcpLogin']>> {
  const port = createMcpLoginPort({
    storage: getStorage(),
    secrets: await getSecretsResolver(),
    mcpManager: result.mcpManager,
    personalities: result.personalities,
    logger: new ConsoleLogger({ component: 'mcp' }),
  });
  disposers.push(async () => port.dispose());
  return port;
}
