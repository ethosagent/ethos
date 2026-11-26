import { VOICE_ORIGIN_TAG } from './voice';

// Shapes written by buildAttachmentAnnotation (core attachment-annotation.ts) and
// buildVoiceOriginAnnotation (core voice-origin.ts); the context assembler joins
// each annotation to the next part with a blank line.
//
// In contracts rather than core (which re-exports it) for the same reason as
// VOICE_ORIGIN_TAG: the browser bundle cannot import core, and the web "Edit &
// rerun" has to strip these blocks from a reloaded user message. One regex, not
// a second spelling in apps/web.
const ATTACHMENTS_BLOCK = /^<attachments>\n[\s\S]*?\n<\/attachments>(?:\n\n|$)/;
const VOICE_BLOCK = new RegExp(`^<${VOICE_ORIGIN_TAG} [^\\n]*/>\\n[^\\n]*(?:\\n\\n|$)`);

/**
 * The text a user would edit: the stored prompt without the leading
 * `<attachments>` and voice-origin annotation blocks, trimmed. Inline
 * attachment text after the annotations stays in `text`. `hadAttachments` is
 * true when an `<attachments>` block was stripped or `contentBlocks` is
 * non-empty. Pinned by packages/core/src/__tests__/session-rewind.test.ts.
 */
export function editablePromptText(
  content: string,
  contentBlocks?: readonly unknown[],
): { text: string; hadAttachments: boolean } {
  let rest = content;
  let hadAttachments = (contentBlocks?.length ?? 0) > 0;
  for (;;) {
    const att = ATTACHMENTS_BLOCK.exec(rest);
    if (att) {
      hadAttachments = true;
      rest = rest.slice(att[0].length);
      continue;
    }
    const voice = VOICE_BLOCK.exec(rest);
    if (voice) {
      rest = rest.slice(voice[0].length);
      continue;
    }
    break;
  }
  return { text: rest.trim(), hadAttachments };
}

// Everything context assembly (packages/core/src/agent-loop/stages/context-assembly.ts)
// puts BEFORE the typed text of a stored user row, one paragraph each:
//  - inline file blocks (core attachment-text-resolver.ts `formatInlinedAttachment`,
//    and the extractor path in context-assembly.ts); greedy up to the last end
//    marker so a document body that itself contains one cannot end the strip early;
//  - the inline-budget overflow line;
//  - attachment error lines (unsupported type, undecodable, extraction failure or
//    size, native-viewing failure or cap), whose shapes are literals in
//    context-assembly.ts, attachment-classifier.ts `unsupportedTypeError` and
//    attachment-blocks.ts `encodeNativeBlocks`.
// Drift is pinned by packages/core/src/__tests__/user-prompt-body.test.ts, which
// builds these strings with the real producers.
const PARA_END = '(?:\\n\\n|$)';
const FILE_BLOCK = /^=== file: [^\n]*===\n[\s\S]*\n=== end file ===(?:\n\n|$)/;
const LEADING_PARAGRAPHS: readonly RegExp[] = [
  FILE_BLOCK,
  new RegExp(`^\\[\\d+ more file\\(s\\) omitted — inline budget exceeded\\]${PARA_END}`),
  new RegExp(`^Failed to read "[^\\n]*": file could not be decoded as text${PARA_END}`),
  new RegExp(`^Failed to extract text from "[^\\n]*"${PARA_END}`),
  new RegExp(`^"[^\\n]*" is too large for extraction \\([^\\n]*\\)${PARA_END}`),
  new RegExp(`^[^\\n]* files aren't supported yet -- supported: [^\\n]*${PARA_END}`),
  new RegExp(`^"[^\\n]*" is [\\d.]+ MB, over the \\d+ MB limit for inline viewing${PARA_END}`),
  new RegExp(`^"[^\\n]*" could not be read for inline viewing${PARA_END}`),
  new RegExp(
    `^\\d+ images/documents attached; at most \\d+ can be viewed in one turn\\. [^\\n]*${PARA_END}`,
  ),
];

/**
 * Only what the user typed: `editablePromptText` plus the inline attachment
 * text, attachment error lines and overflow line that context assembly puts
 * before it. For any consumer that must not carry uploaded document text
 * (the share-link snapshot, plan/phases/share-links.md D5). Text with no
 * leading annotation comes back unchanged apart from trimming. Pinned by
 * packages/types/src/__tests__/prompt-annotations.test.ts.
 */
export function userPromptBody(content: string): string {
  let rest = editablePromptText(content).text;
  for (;;) {
    const hit = LEADING_PARAGRAPHS.map((re) => re.exec(rest)).find((m) => m !== null);
    if (!hit) return rest;
    // Annotation blocks can follow the inline blocks' siblings in any order; re-strip them.
    rest = editablePromptText(rest.slice(hit[0].length)).text;
  }
}
