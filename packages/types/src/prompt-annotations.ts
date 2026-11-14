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
