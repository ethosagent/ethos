import { clock } from '../../lib/row';

// The Memory segment's file line (§5), in mono:
// `~/.ethos/personalities/engineer/memory/MEMORY.md · 2.1 KB · updated 9:41`.

export const MEMORY_FILE_NAME = { memory: 'MEMORY.md', user: 'USER.md' } as const;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** `path` is null for a backend with no file (vector, remote); the name stands in. */
export function fileLine(file: {
  store: 'memory' | 'user';
  content: string;
  path: string | null;
  modifiedAt: string | null;
}): string {
  const where = (file.path ?? MEMORY_FILE_NAME[file.store]).replace(/^\/(Users|home)\/[^/]+/, '~');
  const bytes = new TextEncoder().encode(file.content).length;
  const parts = [where, size(bytes)];
  if (file.modifiedAt) parts.push(`updated ${clock(Date.parse(file.modifiedAt))}`);
  return parts.join(' · ');
}
