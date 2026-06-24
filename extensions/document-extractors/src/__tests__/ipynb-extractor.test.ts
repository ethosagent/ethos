import { describe, expect, it } from 'vitest';
import { IpynbExtractor } from '../ipynb-extractor';

describe('IpynbExtractor', () => {
  it('extracts text from a simple notebook', async () => {
    const nb = {
      cells: [
        { cell_type: 'markdown', source: ['# Hello\n', 'World'] },
        { cell_type: 'code', source: ['print("hi")'], outputs: [{ text: ['hi\n'] }] },
      ],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(nb));
    const result = await new IpynbExtractor().extract(bytes, 'application/x-ipynb+json');
    expect(result.text).toContain('# Hello');
    expect(result.text).toContain('print("hi")');
    expect(result.text).toContain('hi');
    expect(result.format).toBe('markdown');
  });
});
