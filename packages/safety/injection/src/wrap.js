// Provenance wrapping (Ch.3a).
//
// Wraps tool output that came from outside the user's direct input in an
// `<untrusted source="…" tool="…">…</untrusted>` block so the model can
// distinguish data from instructions. The system-prompt prelude in
// `system-prompt.ts` teaches the model how to treat these blocks.
import { sanitizeTemplateTokens } from './sanitize';
/**
 * Sanitize chat-template tokens, then wrap the result in an `<untrusted>` block
 * tagged with the tool name and the optional source label. Always sanitizes
 * first so the placeholder lands inside the fence (not outside).
 */
export function wrapUntrusted({ content, toolName, source }) {
    const { content: sanitized, strippedCount } = sanitizeTemplateTokens(content);
    const sourceAttr = encodeAttr(source ?? 'unknown');
    const toolAttr = encodeAttr(toolName);
    const escaped = escapeBodyTags(sanitized);
    const wrapped = `<untrusted source="${sourceAttr}" tool="${toolAttr}">\n${escaped}\n</untrusted>`;
    return { content: wrapped, strippedTokens: strippedCount };
}
// Escape the opening/closing tags that form the provenance fence so an
// attacker-controlled body cannot close the fence early or open a nested one.
function escapeBodyTags(body) {
    return body.replace(/<(\/?untrusted)/g, '&lt;$1');
}
// Quote and strip newlines / angle brackets so a malicious source label can't
// itself break out of the attribute or close the wrapper element early.
function encodeAttr(value) {
    return value
        .replace(/[\r\n]+/g, ' ')
        .replace(/[<>]/g, '')
        .replace(/"/g, "'")
        .slice(0, 256);
}
