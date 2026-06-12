// Gap 4 — @file / @url inline context references. Extracted from chat.ts so
// both the readline fallback and the TUI (via runTUI's preprocessInput option)
// share one resolver.

import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

/** Max chars inlined per ref — longer content is sliced with a [truncated] suffix. */
const MAX_REF_CHARS = 8000;

function clip(content: string): string {
  if (content.length <= MAX_REF_CHARS) return content;
  return `${content.slice(0, MAX_REF_CHARS)}\n[truncated]`;
}

export async function resolveAtRefs(text: string, cwd: string): Promise<string> {
  const parts: string[] = [];
  let lastIndex = 0;
  const pattern = /@(https?:\/\/[\w./:#?=&%-]+|[\w./~-]+)/g;
  let match: RegExpExecArray | null;

  match = pattern.exec(text);
  while (match !== null) {
    parts.push(text.slice(lastIndex, match.index));
    const ref = match[1];

    if (ref && (ref.startsWith('http://') || ref.startsWith('https://'))) {
      try {
        const body = await fetch(ref).then((r) => r.text());
        parts.push(`\`\`\`\n${clip(body)}\n\`\`\`\n(source: ${ref})`);
      } catch {
        parts.push(match[0]);
      }
    } else if (ref) {
      const resolved = resolve(cwd, ref);
      if (existsSync(resolved)) {
        const content = readFileSync(resolved, 'utf8');
        const ext = extname(ref).slice(1);
        parts.push(`\`\`\`${ext}\n// ${ref}\n${clip(content)}\n\`\`\``);
      } else {
        parts.push(match[0]);
      }
    } else {
      parts.push(match[0]);
    }
    lastIndex = match.index + match[0].length;
    match = pattern.exec(text);
  }
  parts.push(text.slice(lastIndex));
  return parts.join('');
}
