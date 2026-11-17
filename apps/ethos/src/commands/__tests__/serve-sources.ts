// The source of `ethos serve`, for the wiring tests that assert against text
// (`runServe` is a long-running composition root and cannot run under vitest).
//
// `runServe` lives in commands/serve.ts but some of its seams live in sibling
// modules (commands/serve-*.ts, plus the shared constants in _shared.ts). A
// test that reads serve.ts alone silently narrows whenever a seam moves out: a
// "never X anywhere in serve" guard keeps passing while X appears in the moved
// code. So:
//   - whole-source guards (contains / not-contains / counts) read
//     `readServeSources()`, every serve module at once;
//   - ordering guards (`indexOf` a < `indexOf` b) read `serveFileWith(a, b)`,
//     the ONE module holding every anchor. If an extraction splits a pair
//     across two modules this throws, instead of comparing offsets from two
//     different files and passing by accident.
//
// `_shared.ts` is on the list because the port, retry and heartbeat constants
// `runServe` uses moved there; the boot and gateway lists include it too,
// so the three helpers agree.
//
import { fileWith, readCommandSource, readSources } from './command-sources';

// The list holds `runServe` and the modules split out of serve.ts. It does NOT
// hold the siblings that were already separate (serve-helpers, serve-listen,
// serve-a2a-runner): serve-listen's `closeListener` legitimately contains the
// `server.close(() => resolve())` that serve.ts's guards forbid. A module split
// out of serve.ts later must be appended here.

export const SERVE_SOURCE_FILES = [
  'serve.ts',
  'serve-loop.ts',
  'serve-acp.ts',
  'serve-web-api.ts',
  'serve-util.ts',
  '_shared.ts',
] as const;

export function readServeSource(file: (typeof SERVE_SOURCE_FILES)[number]): string {
  return readCommandSource(file);
}

/** Every serve module, concatenated. For whole-source guards only. */
export function readServeSources(): string {
  return readSources(SERVE_SOURCE_FILES);
}

/** The single serve module containing every anchor. Throws when none does, or
 *  when more than one does (an ambiguous anchor). */
export function serveFileWith(...anchors: string[]): string {
  return fileWith('serve', SERVE_SOURCE_FILES, ...anchors);
}
