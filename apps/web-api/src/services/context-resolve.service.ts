import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const MAX_CONTENT = 8000;
const MAX_FILES = 100;
const MAX_DEPTH = 3;

function langFromExt(filename: string): string {
  const ext = extname(filename).slice(1);
  return ext || 'text';
}

export async function resolveRefs(
  refs: string[],
): Promise<Array<{ ref: string; content: string; lang: string }>> {
  return Promise.all(
    refs.map(async (ref) => {
      if (ref.startsWith('http://') || ref.startsWith('https://')) {
        try {
          const body = await fetch(ref).then((r) => r.text());
          return { ref, content: body.slice(0, MAX_CONTENT), lang: 'text' };
        } catch {
          return { ref, content: '', lang: '' };
        }
      }
      const cwd = process.cwd();
      const absPath = join(cwd, ref);
      if (existsSync(absPath)) {
        try {
          const content = readFileSync(absPath, 'utf8');
          return {
            ref,
            content: content.slice(0, MAX_CONTENT),
            lang: langFromExt(ref),
          };
        } catch {
          return { ref, content: '', lang: '' };
        }
      }
      return { ref, content: '', lang: '' };
    }),
  );
}

function walkDir(dir: string, base: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(dir, entry);
    const rel = relative(base, full);
    out.push(rel);
    try {
      if (statSync(full).isDirectory()) {
        walkDir(full, base, depth + 1, out);
      }
    } catch {
      // skip inaccessible entries
    }
  }
}

export function listFiles(prefix?: string): { paths: string[] } {
  const cwd = process.cwd();
  const paths: string[] = [];
  walkDir(cwd, cwd, 0, paths);
  const filtered = prefix ? paths.filter((p) => p.startsWith(prefix)) : paths;
  return { paths: filtered.slice(0, MAX_FILES) };
}
