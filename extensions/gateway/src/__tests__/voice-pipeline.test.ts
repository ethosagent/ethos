import { describe, expect, it } from 'vitest';
import { buildTranscriptText, hasAudioAttachments, isHallucination } from '../voice-pipeline';

describe('isHallucination', () => {
  it('detects common Whisper hallucinations', () => {
    expect(isHallucination('Thanks for watching')).toBe(true);
    expect(isHallucination('Please subscribe')).toBe(true);
    expect(isHallucination('Thank you for watching!')).toBe(true);
    expect(isHallucination('')).toBe(true);
    expect(isHallucination('   ')).toBe(true);
    expect(isHallucination('...')).toBe(true);
    expect(isHallucination('[Music]')).toBe(true);
    expect(isHallucination('you')).toBe(true);
  });

  it('passes real transcripts through', () => {
    expect(isHallucination('Hello, how are you doing today?')).toBe(false);
    expect(isHallucination('Please send me the report')).toBe(false);
    expect(isHallucination('Can you check the deployment?')).toBe(false);
  });
});

describe('hasAudioAttachments', () => {
  it('returns false for undefined', () => {
    expect(hasAudioAttachments(undefined)).toBe(false);
  });

  it('returns false for non-audio attachments', () => {
    expect(
      hasAudioAttachments([{ type: 'image', ref: 'a', url: 'file://a', mimeType: 'image/png' }]),
    ).toBe(false);
  });

  it('returns true when audio attachment present', () => {
    expect(
      hasAudioAttachments([{ type: 'audio', ref: 'a', url: 'file://a', mimeType: 'audio/ogg' }]),
    ).toBe(true);
  });
});

describe('buildTranscriptText', () => {
  it('returns transcript when original text is placeholder', () => {
    const result = buildTranscriptText('(voice message)', [
      { transcript: 'Hello world', attachmentIndex: 0 },
    ]);
    expect(result).toBe('Hello world');
  });

  it('appends transcript to existing text', () => {
    const result = buildTranscriptText('Check this:', [
      { transcript: 'Hello world', attachmentIndex: 0 },
    ]);
    expect(result).toBe('Check this:\n\nHello world');
  });

  it('uses placeholder for null transcripts', () => {
    const result = buildTranscriptText('', [{ transcript: null, attachmentIndex: 0 }]);
    expect(result).toBe('(voice message)');
  });

  it('returns original text when no results', () => {
    expect(buildTranscriptText('hello', [])).toBe('hello');
  });
});

import { stripMarkdown, truncateAtSentenceBoundary } from '../voice-pipeline';

describe('stripMarkdown', () => {
  it('removes code blocks', () => {
    expect(stripMarkdown('Hello\n```js\nconst x = 1;\n```\nWorld')).toBe('Hello\n\nWorld');
  });

  it('removes inline code', () => {
    expect(stripMarkdown('Use `foo()` here')).toBe('Use  here');
  });

  it('extracts link text', () => {
    expect(stripMarkdown('See [docs](http://example.com)')).toBe('See docs');
  });

  it('removes heading markers', () => {
    expect(stripMarkdown('## Title')).toBe('Title');
  });

  it('removes bold/italic', () => {
    expect(stripMarkdown('**bold** and *italic*')).toBe('bold and italic');
  });

  it('passes plain text through', () => {
    expect(stripMarkdown('Hello world')).toBe('Hello world');
  });
});

describe('truncateAtSentenceBoundary', () => {
  it('returns text unchanged when under limit', () => {
    expect(truncateAtSentenceBoundary('Hello.', 100)).toBe('Hello.');
  });

  it('truncates at sentence boundary', () => {
    const text = 'First sentence. Second sentence. Third sentence.';
    const result = truncateAtSentenceBoundary(text, 20);
    expect(result).toBe('First sentence.');
  });

  it('falls back to word boundary', () => {
    const text = 'This is a long sentence without any periods';
    const result = truncateAtSentenceBoundary(text, 25);
    expect(result).toBe('This is a long sentence');
  });
});
