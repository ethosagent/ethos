import { inflateRawSync } from 'node:zlib';
import type { DocumentExtractor, ExtractedDocument } from '@ethosagent/types';

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 100_000;

export class PptxExtractor implements DocumentExtractor {
  readonly name = 'pptx';
  readonly mimeTypes = [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-powerpoint',
  ];
  readonly maxInputBytes = MAX_INPUT_BYTES;

  async extract(bytes: Uint8Array, _mime: string): Promise<ExtractedDocument> {
    const entries = readZipTextEntries(bytes, /ppt\/slides\/slide\d+\.xml$/i);
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const slideTexts: string[] = [];
    for (const entry of entries) {
      const texts = extractXmlText(entry.text);
      if (texts) slideTexts.push(texts);
    }

    let text = slideTexts.map((t, i) => `--- Slide ${i + 1} ---\n${t}`).join('\n\n');
    if (!text) text = '(no text content found in presentation)';

    let truncatedFromChars: number | undefined;
    if (text.length > MAX_OUTPUT_CHARS) {
      truncatedFromChars = text.length;
      text = text.slice(0, MAX_OUTPUT_CHARS);
    }
    return { text, format: 'text', truncatedFromChars, pages: slideTexts.length };
  }
}

function extractXmlText(xml: string): string {
  const texts: string[] = [];
  const regex = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
  let match: RegExpExecArray | null = regex.exec(xml);
  while (match !== null) {
    if (match[1]) texts.push(match[1]);
    match = regex.exec(xml);
  }
  return texts.join(' ');
}

function readZipTextEntries(
  data: Uint8Array,
  pattern: RegExp,
): Array<{ name: string; text: string }> {
  const results: Array<{ name: string; text: string }> = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  while (offset < data.length - 4) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break; // Not a local file header

    const compressionMethod = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);

    const nameBytes = data.slice(offset + 30, offset + 30 + nameLen);
    const name = new TextDecoder().decode(nameBytes);

    const dataStart = offset + 30 + nameLen + extraLen;

    if (pattern.test(name) && compressedSize > 0) {
      const compressed = data.slice(dataStart, dataStart + compressedSize);
      try {
        let decompressed: Buffer;
        if (compressionMethod === 8) {
          decompressed = inflateRawSync(compressed);
        } else if (compressionMethod === 0) {
          decompressed = Buffer.from(compressed);
        } else {
          offset = dataStart + compressedSize;
          continue;
        }
        const text = new TextDecoder().decode(decompressed);
        results.push({ name, text });
      } catch {
        // Skip entries that can't be decompressed
      }
    }

    offset = dataStart + compressedSize;
  }

  return results;
}
