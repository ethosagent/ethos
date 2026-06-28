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
