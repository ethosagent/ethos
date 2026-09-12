import { laneKeyBotKey } from '@ethosagent/core';
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';

/**
 * Every platform `send_message` can address. Single source of truth: the
 * schema enum the model sees and the rejection message a bad call gets are
 * both derived from it, so the two can never disagree about what is supported.
 */
export const SEND_MESSAGE_PLATFORMS = [
  'slack',
  'telegram',
  'discord',
  'whatsapp',
  'email',
] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MessagingSendFn = (
  platform: string,
  target: string,
  body: string,
  botKey?: string,
) => Promise<{
  ok: boolean;
  error?: string;
}>;

export interface MessagingToolsOptions {
  send: MessagingSendFn;
  getAllowedTargets?: (personalityId?: string) => string[] | null;
}

/**
 * The bot this turn is speaking as, when it can send on `targetPlatform` at all.
 *
 * A channel turn runs in a lane keyed `${platform}:${botKey}:${chatId}`
 * (CLAUDE.md, "Channel adapter contract"), so the lane itself names the sender.
 * Reading it back is what binds an outbound `send_message` to the bot whose
 * conversation produced it instead of to whichever adapter registered first for
 * the platform — the failure B-T4 (plan/phases/trust-before-reach.md) closes.
 *
 * `undefined` when this turn's identity says nothing about `targetPlatform`:
 *
 *  - a CLI or web turn — its session key carries no botKey segment;
 *  - a turn on a DIFFERENT platform — a Telegram bot's key is not a Slack
 *    sender, and Slack has its own bots to choose between.
 *
 * `undefined` is not permission to fall back: the send path resolves it as
 * "no bot named", which is a refusal wherever the platform has more than one.
 * See `Gateway.sendAsBot`. The lane-key parse is `laneKeyBotKey` in
 * `@ethosagent/core` — the gateway's own lane bookkeeping decodes through the
 * same function.
 */
export function laneSenderBotKey(
  ctx: { platform?: string; sessionKey?: string },
  targetPlatform: string,
): string | undefined {
  if (!ctx.sessionKey || ctx.platform !== targetPlatform) return undefined;
  return laneKeyBotKey(ctx.sessionKey);
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createMessagingTools(opts: MessagingToolsOptions): Tool[] {
  return [makeSendMessage(opts)];
}

// ---------------------------------------------------------------------------
// send_message
// ---------------------------------------------------------------------------

function makeSendMessage(opts: MessagingToolsOptions): Tool {
  return {
    name: 'send_message',
    description:
      'Send a message to a configured channel — Slack, Telegram, Discord, WhatsApp, or email. ' +
      'Use this whenever the user asks you to post / send / forward / relay something to another channel; ' +
      'do not refuse for permission reasons unless the tool itself returns an error. ' +
      'If the target is outside the operator-configured allowlist the call fails with a clear message that you should surface verbatim.',
    toolset: 'messaging',
    maxResultChars: 1024,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: [...SEND_MESSAGE_PLATFORMS],
          description: 'Target platform',
        },
        target: {
          type: 'string',
          description:
            'Target identifier (channel ID, chat ID, user ID, WhatsApp JID, or email address)',
        },
        body: {
          type: 'string',
          description: 'Message content (supports markdown on platforms that allow it)',
        },
      },
      required: ['platform', 'target', 'body'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      return await executeSendMessage(args as SendMessageArgs, ctx, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SendMessageArgs {
  platform: string;
  target: string;
  body: string;
}

// ---------------------------------------------------------------------------
// execute()
// ---------------------------------------------------------------------------

async function executeSendMessage(
  args: SendMessageArgs,
  ctx: ToolContext,
  opts: MessagingToolsOptions,
): Promise<ToolResult> {
  const { platform, target, body } = args;

  if (!platform || !target || !body) {
    return { ok: false, error: 'platform, target, and body are required', code: 'input_invalid' };
  }

  if (!(SEND_MESSAGE_PLATFORMS as readonly string[]).includes(platform)) {
    return {
      ok: false,
      error: `Unknown platform "${platform}". Supported platforms: ${SEND_MESSAGE_PLATFORMS.join(', ')}.`,
      code: 'input_invalid',
    };
  }

  // Check allowed targets.
  if (opts.getAllowedTargets) {
    const allowed = opts.getAllowedTargets(ctx.personalityId);
    if (allowed !== null) {
      const targetKey = `${platform}:${target}`;
      if (!allowed.includes(targetKey) && !allowed.includes('*')) {
        return {
          ok: false,
          error: `Target "${targetKey}" is not in the personality's allowed messaging targets. Allowed: ${allowed.join(', ') || 'none'}`,
          code: 'input_invalid',
        };
      }
    }
  }

  try {
    const result = await opts.send(platform, target, body, laneSenderBotKey(ctx, platform));
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'Send failed', code: 'execution_failed' };
    }
    return { ok: true, value: `Message sent to ${platform}:${target}` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: 'execution_failed',
    };
  }
}
