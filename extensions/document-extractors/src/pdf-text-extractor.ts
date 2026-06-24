import type { DocumentExtractor, ExtractedDocument } from '@ethosagent/types';

const MAX_INPUT_BYTES = 100 * 1024 * 1024; // 100 MB for PDF fallback
const MAX_OUTPUT_CHARS = 100_000;

export class PdfTextExtractor implements DocumentExtractor {
  readonly name = 'pdf-text';
  readonly mimeTypes = ['application/pdf'];
  readonly maxInputBytes = MAX_INPUT_BYTES;

  async extract(bytes: Uint8Array, _mime: string): Promise<ExtractedDocument> {
    const pdfParse = (await import('pdf-parse')).default;
    const result = await pdfParse(Buffer.from(bytes));
    let text = result.text;
    let truncatedFromChars: number | undefined;
    if (text.length > MAX_OUTPUT_CHARS) {
      truncatedFromChars = text.length;
      text = text.slice(0, MAX_OUTPUT_CHARS);
    }
    return { text, format: 'text', truncatedFromChars, pages: result.numpages };
  }
}
