import type { DocumentExtractor, ExtractedDocument } from '@ethosagent/types';
import * as XLSX from 'xlsx';

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 100_000;

export class XlsxExtractor implements DocumentExtractor {
  readonly name = 'xlsx';
  readonly mimeTypes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
  ];
  readonly maxInputBytes = MAX_INPUT_BYTES;

  async extract(bytes: Uint8Array, _mime: string): Promise<ExtractedDocument> {
    const workbook = XLSX.read(bytes, { type: 'array' });
    const parts: string[] = [];
    for (const name of workbook.SheetNames) {
      const sheet = workbook.Sheets[name];
      if (!sheet) continue;
      const csv = XLSX.utils.sheet_to_csv(sheet);
      parts.push(`## Sheet: ${name}\n${csv}`);
    }
    let text = parts.join('\n\n');
    let truncatedFromChars: number | undefined;
    if (text.length > MAX_OUTPUT_CHARS) {
      truncatedFromChars = text.length;
      text = text.slice(0, MAX_OUTPUT_CHARS);
    }
    return { text, format: 'markdown', truncatedFromChars };
  }
}
