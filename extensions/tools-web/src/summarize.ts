export const SUMMARIZE_AS_IS_MAX = 5_000;
export const SUMMARIZE_SINGLE_PASS_MAX = 500_000;
export const SUMMARIZE_CHUNKED_MAX = 2_000_000;
export const SUMMARIZE_CHUNK_SIZE = 50_000;

export function chunkText(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

export async function summarizeBySize(
  text: string,
  summarize: (chunk: string) => Promise<string>,
): Promise<{ value: string } | { tooLarge: true }> {
  const len = text.length;
  if (len < SUMMARIZE_AS_IS_MAX) return { value: text };
  if (len < SUMMARIZE_SINGLE_PASS_MAX) return { value: await summarize(text) };
  if (len < SUMMARIZE_CHUNKED_MAX) {
    const chunks = chunkText(text, SUMMARIZE_CHUNK_SIZE);
    const summaries = await Promise.all(chunks.map(summarize));
    return { value: summaries.join('\n\n') };
  }
  return { tooLarge: true };
}
