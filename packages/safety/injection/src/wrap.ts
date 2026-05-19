// Provenance wrapping (Ch.3a).
//
// Wraps tool output that came from outside the user's direct input in an
// `<untrusted source="…" tool="…">…</untrusted>` block so the model can
// distinguish data from instructions. The system-prompt prelude in
// `system-prompt.ts` teaches the model how to treat these blocks.

import { sanitizeTemplateTokens } from './sanitize';

export interface WrapInput {
  content: string;
  toolName: string;
  /**
   * Best-effort origin label (URL, file path, sender email, command).
   * Optional: tools are not required to surface a source — when absent,
   * the wrapper records `source="unknown"` and the tool name is still
   * captured. The label is sanitized to keep the attribute one-line.
   */
  source?: string;
}

export interface WrapResult {
  /** The wrapped content suitable for placing into a tool_result block. */
  content: string;
  /** Sanitization stats — non-zero `strippedTokens` means an injection was
   *  attempted via a template token; surface to the classifier as a hit. */
  strippedTokens: number;
}

/**
 * Sanitize chat-template tokens, then wrap the result in an `<untrusted>` block
 * tagged with the tool name and the optional source label. Always sanitizes
 * first so the placeholder lands inside the fence (not outside).
 */
export function wrapUntrusted({ content, toolName, source }: WrapInput): WrapResult {
  const { content: sanitized, strippedCount } = sanitizeTemplateTokens(content);
  const sourceAttr = encodeAttr(source ?? 'unknown');
  const toolAttr = encodeAttr(toolName);
  const escaped = escapeBodyTags(sanitized);
  const wrapped = `<untrusted source="${sourceAttr}" tool="${toolAttr}">\n${escaped}\n</untrusted>`;
  return { content: wrapped, strippedTokens: strippedCount };
}

// Escape the opening/closing tags that form the provenance fence so an
// attacker-controlled body cannot close the fence early or open a nested one.
function escapeBodyTags(body: string): string {
  return body.replace(/<(\/?untrusted)/g, '&lt;$1');
}

// Quote and strip newlines / angle brackets so a malicious source label can't
// itself break out of the attribute or close the wrapper element early.
function encodeAttr(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/"/g, "'")
    .slice(0, 256);
}
