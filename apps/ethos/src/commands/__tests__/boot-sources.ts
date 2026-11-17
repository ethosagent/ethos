// The source of `ethos boot`, for the wiring tests that assert against text
// (`runBoot` is a long-running composition root and cannot run under vitest).
//
// `runBoot` lives in commands/boot.ts but some of its phases live in sibling
// modules (commands/boot-*.ts). A test that reads boot.ts alone silently
// narrows whenever a phase moves out: a "never X anywhere in boot" guard keeps
// passing while X appears in the moved phase. So:
//   - whole-source guards (contains / not-contains / counts) read
//     `readBootSources()`, every boot module at once;
//   - ordering guards (`indexOf` a < `indexOf` b) read `bootFileWith(a, b)`,
//     the ONE module holding every anchor. If an extraction splits a pair
//     across two modules this throws, instead of comparing offsets from two
//     different files and passing by accident.

import { fileWith, readCommandSource, readSources } from './command-sources';

/** `runBoot` first, then the modules it delegates phases to. */
export const BOOT_SOURCE_FILES = [
  'boot.ts',
  'boot-reload.ts',
  'boot-context.ts',
  'boot-constants.ts',
  'boot-digest.ts',
] as const;

export function readBootSource(file: (typeof BOOT_SOURCE_FILES)[number]): string {
  return readCommandSource(file);
}

/** Every boot module, concatenated. For whole-source guards only. */
export function readBootSources(): string {
  return readSources(BOOT_SOURCE_FILES);
}

/** The single boot module containing every anchor. Throws when none does, or
 *  when more than one does (an ambiguous anchor). */
export function bootFileWith(...anchors: string[]): string {
  return fileWith('boot', BOOT_SOURCE_FILES, ...anchors);
}
