import type { DocumentExtractorRegistry } from '@ethosagent/types';
import { DocxExtractor } from './docx-extractor';
import { IpynbExtractor } from './ipynb-extractor';
import { PdfTextExtractor } from './pdf-text-extractor';
import { PptxExtractor } from './pptx-extractor';
import { XlsxExtractor } from './xlsx-extractor';

export function registerBuiltinExtractors(registry: DocumentExtractorRegistry): void {
  registry.register(new DocxExtractor());
  registry.register(new XlsxExtractor());
  registry.register(new PptxExtractor());
  registry.register(new IpynbExtractor());
  registry.register(new PdfTextExtractor());
}
