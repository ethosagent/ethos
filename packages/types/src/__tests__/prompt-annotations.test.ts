import { describe, expect, it } from 'vitest';
import { userPromptBody } from '../prompt-annotations';

const ATT = '<attachments>\n- report.pdf (application/pdf, 12 KB)\n</attachments>';
const VOICE = '<voice-origin mode="spoken" />\nThis turn was spoken.';

describe('userPromptBody', () => {
  it('returns text with no annotations unchanged (trimmed)', () => {
    expect(userPromptBody('  hello there ')).toBe('hello there');
  });

  it('strips attachments, voice tag, error lines and inline file blocks', () => {
    const content = [
      ATT,
      VOICE,
      'Failed to read "a.bin": file could not be decoded as text',
      '=== file: notes.txt ===\nSECRET BODY\n\nline two\n=== end file ===',
      'what does it say?',
    ].join('\n\n');
    expect(userPromptBody(content)).toBe('what does it say?');
  });

  it('strips several files and a truncation note', () => {
    const content = [
      '=== file: a.txt [truncated to 10 chars from 99,999] ===\nAAAA\n=== end file ===',
      '=== file: b.txt ===\nBBBB\n=== end file ===',
      '[2 more file(s) omitted — inline budget exceeded]',
      'summarise',
    ].join('\n\n');
    expect(userPromptBody(content)).toBe('summarise');
  });

  it('does not stop early on an end marker inside a document body', () => {
    const content = '=== file: a.txt ===\nx\n=== end file ===\n\nLEAK\n=== end file ===\n\nask';
    expect(userPromptBody(content)).toBe('ask');
  });

  it.each([
    'Failed to extract text from "x.docx"',
    '"x.pdf" is too large for extraction (30.0 MB, max 20 MB)',
    '"a.zip" (application/zip) files aren\'t supported yet -- supported: images (PNG), PDF',
    '"x.png" is 9.0 MB, over the 5 MB limit for inline viewing',
    '"x.png" could not be read for inline viewing',
    '25 images/documents attached; at most 20 can be viewed in one turn. They are listed by name below.',
  ])('strips error line %s', (line) => {
    expect(userPromptBody(`${line}\n\nhi`)).toBe('hi');
  });

  it('keeps typed text that merely mentions a file marker mid-message', () => {
    const typed = 'see === file: x === in the docs';
    expect(userPromptBody(typed)).toBe(typed);
  });

  it('returns empty when the row is annotations only', () => {
    expect(userPromptBody(ATT)).toBe('');
  });
});
