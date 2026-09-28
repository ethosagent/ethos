import { redactString } from '@ethosagent/safety-redact';
import { formatApprovalArgs, TRUNCATED_MARKER, truncateWithMarker } from '@ethosagent/surface-kit';

/** Telegram's hard limit for one text message. */
const TELEGRAM_MESSAGE_MAX = 4096;
/** Same preview size the Slack and Discord cards use (`ARGS_PREVIEW_MAX`). */
const ARGS_PREVIEW_MAX = 2500;
const REASON_MAX = 1000;

/**
 * The approval card's text (UBP-050). The raw `JSON.stringify(args)` it
 * replaced echoed credentials into the chat and, past ~4000 chars, failed
 * Telegram's 4096 limit — and a failed post is an auto-deny, so a long call
 * could never be approved. Args go through the formatter every channel card
 * shares (`formatApprovalArgs`, @ethosagent/surface-kit — redaction, then the
 * cap); no fence handling, because the card is sent as plain text, not HTML.
 * Every part is capped so the whole stays under the limit, with an explicit
 * "(truncated)" marker. Pinned by `__tests__/outbound-ubp.test.ts`.
 */
export function formatApprovalCardText(
  toolName: string,
  reason: string | null,
  args: unknown,
): string {
  const reasonLine = reason
    ? `\nReason: ${truncateWithMarker(redactString(reason), REASON_MAX)}`
    : '';
  const argsLine = args
    ? `\nArgs: ${formatApprovalArgs(args, { maxChars: ARGS_PREVIEW_MAX })}`
    : '';
  const text = `Tool approval required: ${toolName}${reasonLine}${argsLine}`;
  return text.length > TELEGRAM_MESSAGE_MAX
    ? `${text.slice(0, TELEGRAM_MESSAGE_MAX - TRUNCATED_MARKER.length)}${TRUNCATED_MARKER}`
    : text;
}
