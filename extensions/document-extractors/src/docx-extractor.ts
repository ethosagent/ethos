import type { DocumentExtractor, ExtractedDocument } from '@ethosagent/types';
import mammoth from 'mammoth';

const MAX_INPUT_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_OUTPUT_CHARS = 100_000;

export class DocxExtractor implements DocumentExtractor {
  readonly name = 'docx';
  readonly mimeTypes = [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
  ];
  readonly maxInputBytes = MAX_INPUT_BYTES;

  async extract(bytes: Uint8Array, _mime: string): Promise<ExtractedDocument> {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    let text = result.value;
    let truncatedFromChars: number | undefined;
    if (text.length > MAX_OUTPUT_CHARS) {
      truncatedFromChars = text.length;
      text = text.slice(0, MAX_OUTPUT_CHARS);
    }
    return { text, format: 'text', truncatedFromChars };
  }
}
