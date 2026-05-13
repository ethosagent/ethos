import type { StoredMessage } from '@ethosagent/types';

export interface RecapOptions {
  turns?: number;
  lineWidth?: number;
}

export interface RecapResult {
  lines: string[];
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  // Collect whole code points until we fill maxLen UTF-16 code units.
  // This avoids splitting surrogate pairs while keeping the original length gate.
  const codePoints = Array.from(text);
  let charCount = 0;
  let cpIdx = 0;
  while (cpIdx < codePoints.length) {
    const cp = codePoints[cpIdx] ?? '';
    if (charCount + cp.length > maxLen) break;
    charCount += cp.length;
    cpIdx++;
  }
  return `${codePoints.slice(0, cpIdx).join('')}…`;
}

export function formatRecap(
  messages: StoredMessage[],
  opts: RecapOptions = {},
): RecapResult | null {
  const turns = opts.turns ?? 3;
  if (turns === 0) return null;

  const lineWidth = opts.lineWidth ?? 80;
  const contentWidth = lineWidth - 4; // account for "│ " prefix and padding

  // Filter to only user and assistant messages (ignore tool_result, system, etc.)
  const conversational = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (conversational.length === 0) return null;

  // Take last N turn pairs (each pair = 1 user + 1 assistant, so 2*turns messages)
  const tail = conversational.slice(-turns * 2);

  const innerWidth = lineWidth - 2; // ┌─...─┐ border
  const headerLabel = ' Previous conversation ';
  const topFill = '─'.repeat(Math.max(0, innerWidth - headerLabel.length));
  const top = `┌${headerLabel}${topFill}┐`;
  const bottom = `└${'─'.repeat(innerWidth)}┘`;

  const body: string[] = [];
  for (const msg of tail) {
    const prefix = msg.role === 'user' ? 'You: ' : 'Agent: ';
    const maxContent = contentWidth - prefix.length;
    const text = msg.content.replace(/\n/g, ' ');
    const truncated = truncate(text, maxContent);
    const line = `${prefix}${truncated}`;
    body.push(`│ ${line.padEnd(contentWidth)} │`);
  }

  return { lines: [top, ...body, bottom] };
}
