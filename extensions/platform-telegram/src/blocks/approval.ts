import { redactJson, redactString } from '@ethosagent/safety-redact';

/** Telegram's hard limit for one text message. */
const TELEGRAM_MESSAGE_MAX = 4096;
/** Same preview size the Slack and Discord cards use (`ARGS_PREVIEW_MAX`). */
const ARGS_PREVIEW_MAX = 2500;
const REASON_MAX = 1000;
const TRUNCATED = '\n… (truncated)';

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}${TRUNCATED}` : text;
}

/**
 * Credential-redacted, length-capped rendering of a gated call's args — the
 * same rules as `formatArgs` in `extensions/platform-slack/src/blocks/approval.ts`
 * and `extensions/platform-discord/src/blocks/approval.ts`, copied rather than
 * imported because an adapter must not depend on a sibling adapter's package.
 * Redaction runs on the values BEFORE `JSON.stringify`, because the
 * generic-secret pattern anchors on a string boundary JSON quoting would hide.
 * No fence handling: the Telegram card is sent as plain text, not HTML.
 *
 * Redaction is a leak-reducer, not a boundary (G-RED): a credential in a shape
 * the pattern set does not know still reaches the chat.
 */
function formatArgs(args: unknown): string {
  let text: string;
  if (typeof args === 'string') {
    text = redactString(args);
  } else {
    try {
      const safe = typeof args === 'object' ? redactJson(args as Record<string, unknown>) : args;
      text = JSON.stringify(safe, null, 2);
    } catch {
      text = redactString(String(args));
    }
  }
  return cap(text, ARGS_PREVIEW_MAX);
}

/**
 * The approval card's text (UBP-050). The raw `JSON.stringify(args)` it
 * replaced echoed credentials into the chat and, past ~4000 chars, failed
 * Telegram's 4096 limit — and a failed post is an auto-deny, so a long call
 * could never be approved. Every part is capped so the whole stays under the
 * limit, with an explicit "(truncated)" marker. Pinned by
 * `__tests__/outbound-ubp.test.ts`.
 */
export function formatApprovalCardText(
  toolName: string,
  reason: string | null,
  args: unknown,
): string {
  const reasonLine = reason ? `\nReason: ${cap(redactString(reason), REASON_MAX)}` : '';
  const argsLine = args ? `\nArgs: ${formatArgs(args)}` : '';
  const text = `Tool approval required: ${toolName}${reasonLine}${argsLine}`;
  return text.length > TELEGRAM_MESSAGE_MAX
    ? `${text.slice(0, TELEGRAM_MESSAGE_MAX - TRUNCATED.length)}${TRUNCATED}`
    : text;
}
