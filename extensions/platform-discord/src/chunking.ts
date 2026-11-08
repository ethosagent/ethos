import { chunkText as chunkTextAt } from '@ethosagent/surface-kit';

export { reflowChunks } from '@ethosagent/surface-kit';

/** Shared newline-preferring chunker; Discord's default limit is 2000. */
export function chunkText(text: string, maxLength = 2000): string[] {
  return chunkTextAt(text, maxLength);
}
