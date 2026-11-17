// Shared mechanics behind boot-sources.ts and serve-sources.ts: read a command's
// source as the concatenation of the modules that make it up, so a wiring test
// that asserts against text cannot silently narrow when a phase moves out.
// Each wrapper owns its file list; see those files for the guard conventions.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const COMMANDS = join(import.meta.dirname, '..');

/** One module of `commands/`, by file name. */
export function readCommandSource(file: string): string {
  return readFileSync(join(COMMANDS, file), 'utf8');
}

/** Every listed module, concatenated. For whole-source guards only. */
export function readSources(files: readonly string[]): string {
  return files.map(readCommandSource).join('\n');
}

/** The single listed module containing every anchor. Throws when none does, or
 *  when more than one does (an ambiguous anchor). `label` names the command in
 *  the error. */
export function fileWith(label: string, files: readonly string[], ...anchors: string[]): string {
  const hits = files.filter((file) => {
    const src = readCommandSource(file);
    return anchors.every((anchor) => src.includes(anchor));
  });
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one ${label} module holding ${JSON.stringify(anchors)}, found ${JSON.stringify(hits)}`,
    );
  }
  return readCommandSource(hits[0] as string);
}
