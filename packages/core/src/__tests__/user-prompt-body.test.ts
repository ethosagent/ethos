// Drift pin for userPromptBody (packages/types/src/prompt-annotations.ts): it
// must strip what context assembly really writes before the typed text. Each
// prefix part is built with the real producer, not a copy of its format.
import { type Attachment, userPromptBody } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildAttachmentAnnotation } from '../attachment-annotation';
import { encodeNativeBlocks } from '../attachment-blocks';
import { unsupportedTypeError } from '../attachment-classifier';
import { formatInlinedAttachment } from '../attachment-text-resolver';
import { buildVoiceOriginAnnotation } from '../voice-origin';

const att = (name: string, mimeType: string): Attachment => ({
  type: 'file',
  ref: name,
  url: `file:///${name}`,
  mimeType,
  filename: name,
});

describe('userPromptBody vs context-assembly producers', () => {
  it('strips every producer output, leaving only the typed text', async () => {
    const overCap = Array.from({ length: 40 }, (_, i) => att(`i${i}.png`, 'image/png'));
    const capErrors = (await encodeNativeBlocks(overCap, {})).errors;
    const unreadable = (await encodeNativeBlocks([att('x.png', 'image/png')], {})).errors;
    const parts = [
      buildAttachmentAnnotation([att('r.pdf', 'application/pdf')]),
      buildVoiceOriginAnnotation({ transport: 'browser-talk-mode', speaker: 'owner' }),
      unsupportedTypeError('application/zip', 'a.zip'),
      ...capErrors,
      ...unreadable,
      formatInlinedAttachment({
        attachment: att('n.txt', 'text/plain'),
        text: 'UPLOADED SECRET',
        truncatedFromChars: 99_999,
      }),
      '[1 more file(s) omitted — inline budget exceeded]',
    ];
    expect(parts.every((p) => p.length > 0)).toBe(true);
    const stored = `${parts.join('\n\n')}\n\nwhat is in it?`;
    expect(userPromptBody(stored)).toBe('what is in it?');
  });
});
