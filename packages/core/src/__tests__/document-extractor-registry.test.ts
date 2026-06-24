import type { DocumentExtractor, ExtractedDocument } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { DefaultDocumentExtractorRegistry } from '../providers/document-extractor-registry';

const fakeExtractor: DocumentExtractor = {
  name: 'test',
  mimeTypes: ['application/test', 'application/test2'],
  async extract(): Promise<ExtractedDocument> {
    return { text: 'extracted', format: 'text' };
  },
};

describe('DefaultDocumentExtractorRegistry', () => {
  it('registers and resolves by MIME', () => {
    const reg = new DefaultDocumentExtractorRegistry();
    reg.register(fakeExtractor);
    expect(reg.for('application/test')).toBe(fakeExtractor);
    expect(reg.for('application/test2')).toBe(fakeExtractor);
    expect(reg.for('application/unknown')).toBeUndefined();
  });

  it('lists registered extractor names', () => {
    const reg = new DefaultDocumentExtractorRegistry();
    reg.register(fakeExtractor);
    expect(reg.list()).toEqual(['test']);
  });

  it('is case-insensitive on MIME lookup', () => {
    const reg = new DefaultDocumentExtractorRegistry();
    reg.register(fakeExtractor);
    expect(reg.for('APPLICATION/TEST')).toBe(fakeExtractor);
  });
});
