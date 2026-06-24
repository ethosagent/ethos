export interface ExtractedDocument {
  text: string;
  format: 'markdown' | 'text';
  truncatedFromChars?: number;
  pages?: number;
}

export interface DocumentExtractor {
  readonly name: string;
  readonly mimeTypes: string[];
  readonly maxInputBytes?: number;
  extract(bytes: Uint8Array, mime: string): Promise<ExtractedDocument>;
}

export interface DocumentExtractorRegistry {
  register(extractor: DocumentExtractor): void;
  for(mime: string): DocumentExtractor | undefined;
  list(): string[];
}
