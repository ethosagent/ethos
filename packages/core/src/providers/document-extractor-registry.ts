import type { DocumentExtractor, DocumentExtractorRegistry } from '@ethosagent/types';

export class DefaultDocumentExtractorRegistry implements DocumentExtractorRegistry {
  private readonly extractors = new Map<string, DocumentExtractor>();

  register(extractor: DocumentExtractor): void {
    for (const mime of extractor.mimeTypes) {
      this.extractors.set(mime.toLowerCase(), extractor);
    }
  }

  for(mime: string): DocumentExtractor | undefined {
    return this.extractors.get(mime.toLowerCase());
  }

  list(): string[] {
    return [...new Set([...this.extractors.values()].map((e) => e.name))];
  }
}
