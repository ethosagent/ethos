// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------
export function createMessagingTools(opts) {
  return [makeSendMessage(opts)];
}
// ---------------------------------------------------------------------------
// send_message
// ---------------------------------------------------------------------------
function makeSendMessage(opts) {
  return {
    name: 'send_message',
    description:
      'Send a message to a configured channel — Slack, Telegram, Discord, or email. ' +
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
          enum: ['slack', 'telegram', 'discord', 'email'],
          description: 'Target platform',
        },
        target: {
          type: 'string',
          description: 'Target identifier (channel ID, chat ID, user ID, or email address)',
        },
        body: {
          type: 'string',
          description: 'Message content (supports markdown on platforms that allow it)',
        },
      },
      required: ['platform', 'target', 'body'],
    },
    async execute(args, ctx) {
      return await executeSendMessage(args, ctx, opts);
    },
  };
}
// ---------------------------------------------------------------------------
// execute()
// ---------------------------------------------------------------------------
async function executeSendMessage(args, ctx, opts) {
  const { platform, target, body } = args;
  if (!platform || !target || !body) {
    return { ok: false, error: 'platform, target, and body are required', code: 'input_invalid' };
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
    const result = await opts.send(platform, target, body);
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
