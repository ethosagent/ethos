// Telegram's fence-aware text chunker, shared by the adapter send path and the card renderer
// (`cards/render.ts`). Moved out of `index.ts` so the renderer can use it without an import cycle.

/**
 * The opening line of a ``` fence left open at the end of `text`, or
 * `undefined` when every fence in it is closed. A fence line is one whose
 * first non-blank characters are three backticks.
 */
function openFenceAtEnd(text: string): string | undefined {
  let open: string | undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('```')) continue;
    open = open === undefined ? trimmed : undefined;
  }
  return open;
}

/** Where to cut `text` so the head fits `limit`: a newline, else a space. */
function cutPoint(text: string, limit: number): number {
  const newlineAt = text.lastIndexOf('\n', limit);
  if (newlineAt > limit * 0.6) return newlineAt + 1;
  const spaceAt = text.lastIndexOf(' ', limit);
  if (spaceAt > limit * 0.6) return spaceAt + 1;
  return limit;
}

/** Room a chunk reserves for the "\n```" that closes a fence it splits. */
const FENCE_CLOSE_RESERVE = 4;

/**
 * Split `text` into chunks of at most `maxLength`.
 *
 * Fence-aware (UBP-051): a chunk boundary that falls inside a ``` block
 * closes the fence at the end of that chunk and reopens it — language tag
 * included — at the start of the next, so each chunk renders its code as code
 * on its own. Pinned by `__tests__/format-code.test.ts`.
 */
export function chunkText(text: string, maxLength = 4096): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let cutAt = cutPoint(remaining, maxLength);
    if (openFenceAtEnd(remaining.slice(0, cutAt)) !== undefined) {
      cutAt = cutPoint(remaining, maxLength - FENCE_CLOSE_RESERVE);
    }
    let chunk = remaining.slice(0, cutAt);
    let rest = remaining.slice(cutAt);
    const opener = openFenceAtEnd(chunk);
    // Reopen only when the next chunk still makes progress past the opener.
    if (opener !== undefined && cutAt > opener.length + 1) {
      chunk += chunk.endsWith('\n') ? '```' : '\n```';
      rest = `${opener}\n${rest}`;
    }

    chunks.push(chunk);
    remaining = rest;
  }

  return chunks;
}
