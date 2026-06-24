import type { DocumentExtractor, ExtractedDocument } from '@ethosagent/types';

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 100_000;

interface NotebookCell {
  cell_type: string;
  source: string | string[];
  outputs?: NotebookOutput[];
}

interface NotebookOutput {
  text?: string | string[];
  data?: Record<string, unknown>;
}

export class IpynbExtractor implements DocumentExtractor {
  readonly name = 'ipynb';
  readonly mimeTypes = ['application/x-ipynb+json'];
  readonly maxInputBytes = MAX_INPUT_BYTES;

  async extract(bytes: Uint8Array, _mime: string): Promise<ExtractedDocument> {
    const raw = new TextDecoder().decode(bytes);
    const nb = JSON.parse(raw) as {
      cells?: NotebookCell[];
      worksheets?: Array<{ cells?: NotebookCell[] }>;
    };
    const cells: NotebookCell[] = nb.cells ?? nb.worksheets?.[0]?.cells ?? [];
    const parts: string[] = [];

    for (const cell of cells) {
      const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '');
      if (!source.trim()) continue;

      if (cell.cell_type === 'markdown') {
        parts.push(source);
      } else if (cell.cell_type === 'code') {
        parts.push(`\`\`\`\n${source}\n\`\`\``);
        const outputs = cell.outputs ?? [];
        for (const out of outputs) {
          const textData = out.data as Record<string, unknown> | undefined;
          const text = out.text ?? textData?.['text/plain'];
          if (text) {
            const outStr = Array.isArray(text) ? text.join('') : String(text);
            parts.push(`Output:\n\`\`\`\n${outStr}\n\`\`\``);
          }
        }
      } else {
        parts.push(source);
      }
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
