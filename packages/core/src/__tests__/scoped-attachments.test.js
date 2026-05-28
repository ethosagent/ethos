import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ScopedAttachmentsImpl } from '../scoped/scoped-attachments';

describe('ScopedAttachmentsImpl', () => {
  const cache = new InMemoryAttachmentCache();
  const IMAGE_ATT = {
    type: 'image',
    ref: 'att-0',
    url: 'file:///tmp/ethos-test-cache/attachments/abc/msg/photo.jpg',
    mimeType: 'image/jpeg',
    filename: 'photo.jpg',
  };
  const FILE_ATT = {
    type: 'file',
    ref: 'att-1',
    url: 'file:///tmp/ethos-test-cache/attachments/abc/msg/report.pdf',
    mimeType: 'application/pdf',
    filename: 'report.pdf',
  };
  it('list() filters by declared kinds', () => {
    const scoped = new ScopedAttachmentsImpl([IMAGE_ATT, FILE_ATT], ['image'], cache);
    expect(scoped.list()).toEqual([IMAGE_ATT]);
  });
  it('list() returns all when kinds is *', () => {
    const scoped = new ScopedAttachmentsImpl([IMAGE_ATT, FILE_ATT], '*', cache);
    expect(scoped.list()).toEqual([IMAGE_ATT, FILE_ATT]);
  });
  it('open() resolves file:// URL to a path via cache', async () => {
    const testCache = new InMemoryAttachmentCache();
    const url = await testCache.write(new Uint8Array([1, 2, 3]), {
      sessionKey: 'test',
      messageId: 'msg-1',
      filename: 'photo.jpg',
      mime: 'image/jpeg',
    });
    const att = { type: 'image', ref: 'att-0', url, mimeType: 'image/jpeg' };
    const scoped = new ScopedAttachmentsImpl([att], ['image'], testCache);
    const result = await scoped.open(att);
    expect(result.path).toContain('photo.jpg');
  });
  it('open() throws for non-file:// URLs', async () => {
    const att = {
      type: 'image',
      ref: 'att-0',
      url: 'https://example.com/img.jpg',
      mimeType: 'image/jpeg',
    };
    const scoped = new ScopedAttachmentsImpl([att], ['image'], cache);
    await expect(scoped.open(att)).rejects.toThrow('Unsupported URL scheme');
  });
  it('openByRef() finds by ref and opens', async () => {
    const testCache = new InMemoryAttachmentCache();
    const url = await testCache.write(new Uint8Array([1]), {
      sessionKey: 'test',
      messageId: 'msg',
      filename: 'f.txt',
      mime: 'text/plain',
    });
    const att = { type: 'file', ref: 'att-0', url, mimeType: 'text/plain' };
    const scoped = new ScopedAttachmentsImpl([att], '*', testCache);
    const result = await scoped.openByRef('att-0');
    expect(result.path).toContain('f.txt');
  });
  it('openByRef() throws for unknown ref', async () => {
    const scoped = new ScopedAttachmentsImpl([], '*', cache);
    await expect(scoped.openByRef('att-99')).rejects.toThrow('No attachment with ref');
  });
});
