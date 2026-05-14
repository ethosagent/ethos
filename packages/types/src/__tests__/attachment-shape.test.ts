import { describe, expect, it } from 'vitest';
import type { Attachment, AttachmentCache } from '../index';

describe('Attachment shape', () => {
  it('requires url and ref, has no data field', () => {
    const att: Attachment = {
      type: 'image',
      ref: 'att-0',
      url: 'file:///tmp/cache/abc/img.jpg',
      mimeType: 'image/jpeg',
    };
    expect(att.ref).toBe('att-0');
    expect(att.url).toBe('file:///tmp/cache/abc/img.jpg');
    expect('data' in att).toBe(false);
  });

  it('type union is image | file', () => {
    const img: Attachment = { type: 'image', ref: 'att-0', url: 'file:///a', mimeType: 'image/png' };
    const doc: Attachment = { type: 'file', ref: 'att-1', url: 'file:///b', mimeType: 'application/pdf' };
    expect(img.type).toBe('image');
    expect(doc.type).toBe('file');
  });
});

describe('AttachmentCache interface', () => {
  it('is importable as a type', () => {
    const _check: AttachmentCache | undefined = undefined;
    expect(_check).toBeUndefined();
  });
});
