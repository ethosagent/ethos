import { chunkText as chunkTextAt } from '@ethosagent/surface-kit';

export { reflowChunks } from '@ethosagent/surface-kit';

/** Shared newline-preferring chunker; Slack's default limit is 3000. */
export function chunkText(text: string, maxLength = 3000): string[] {
  return chunkTextAt(text, maxLength);
}
