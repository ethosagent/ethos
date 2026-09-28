// The args preview on a channel's tool-approval card (UBP-050, V-GC-7). One
// formatter for Slack, Discord and Telegram, so the redaction and truncation
// rules cannot drift apart per adapter. Each card passes its own length limit
// and, where its markup needs it, its own code-fence neutralizer.

import { redactJson, redactString } from '@ethosagent/safety-redact';

/** Appended wherever a card cuts text short, so a reader knows it was cut. */
export const TRUNCATED_MARKER = '\n… (truncated)';

/** `text` cut to `max` chars plus {@link TRUNCATED_MARKER}, or unchanged. */
export function truncateWithMarker(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}${TRUNCATED_MARKER}` : text;
}

export interface ApprovalArgsFormat {
  /** The platform's preview cap, in chars, before the truncation marker. */
  maxChars: number;
  /**
   * Markup hardening for the platform, run on the redacted text BEFORE the cap
   * so the cap still bounds the result: Slack and Discord break up backtick
   * runs that would close the code fence the card wraps the args in. Absent
   * for a card sent as plain text (Telegram).
   */
  neutralize?: (text: string) => string;
}

/**
 * Credential-redacted, length-capped rendering of a gated call's args.
 *
 * Redaction runs on the values BEFORE `JSON.stringify`, not on its output: the
 * generic-secret pattern anchors on a string boundary, which JSON quoting would
 * hide. It sits inside the `try` because a circular arg would otherwise
 * overflow the stack outside the stringify guard; that falls back to the
 * redacted `String(args)`.
 *
 * Redaction is a leak-reducer, not a boundary (G-RED): a credential in a shape
 * the pattern set does not know still reaches the chat. Pinned by
 * `__tests__/approval-args.test.ts` and each adapter's approval-card tests.
 */
export function formatApprovalArgs(args: unknown, format: ApprovalArgsFormat): string {
  let text: string;
  if (args === null || args === undefined) {
    text = '(no arguments)';
  } else if (typeof args === 'string') {
    text = redactString(args);
  } else {
    try {
      // `args` is non-null here, so `typeof 'object'` means object or array —
      // both of which `redactJson` walks.
      const safe = typeof args === 'object' ? redactJson(args as Record<string, unknown>) : args;
      text = JSON.stringify(safe, null, 2);
    } catch {
      text = redactString(String(args));
    }
  }
  if (format.neutralize) text = format.neutralize(text);
  return truncateWithMarker(text, format.maxChars);
}
