import type { Attachment, AttachmentCache, Storage } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { formatInlinedAttachment, resolveTextAttachment } from '../attachment-text-resolver';

function textAtt(name: string, url: string, mime = 'text/plain'): Attachment {
  return { type: 'file', ref: url, url, mimeType: mime, filename: name };
}

describe('resolveTextAttachment', () => {
  it('resolves data: URL attachments', async () => {
    const content = 'Hello, world!';
    const b64 = Buffer.from(content).toString('base64');
    const att = textAtt('hello.txt', `data:text/plain;base64,${b64}`);
    const result = await resolveTextAttachment(att, undefined, undefined);
    expect(result.text).toBe(content);
    expect(result.truncatedFromChars).toBeUndefined();
  });

  it('resolves file:// URL attachments', async () => {
    const content = 'File content here';
    const bytes = new TextEncoder().encode(content);
    const mockStorage = {
      readBytes: async () => bytes,
    } as unknown as Storage;
    const mockCache = {
      resolveLocalPath: (url: string) => url.replace('file://', ''),
    } as unknown as AttachmentCache;
    const att = textAtt('test.txt', 'file:///tmp/test.txt');
    const result = await resolveTextAttachment(att, mockStorage, mockCache);
    expect(result.text).toBe(content);
  });
});

describe('formatInlinedAttachment', () => {
  it('formats with filename', () => {
    const att = textAtt('readme.md', 'data:text/plain;base64,aGVsbG8=');
    const formatted = formatInlinedAttachment({ attachment: att, text: 'hello' });
    expect(formatted).toContain('=== file: readme.md ===');
    expect(formatted).toContain('hello');
    expect(formatted).toContain('=== end file ===');
  });

  it('includes truncation note', () => {
    const att = textAtt('big.txt', 'data:text/plain;base64,aGVsbG8=');
    const formatted = formatInlinedAttachment({
      attachment: att,
      text: 'hello',
      truncatedFromChars: 100000,
    });
    expect(formatted).toContain('truncated');
    expect(formatted).toContain('100,000');
  });
});
