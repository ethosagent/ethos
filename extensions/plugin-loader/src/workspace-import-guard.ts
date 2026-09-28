// ---------------------------------------------------------------------------
// Workspace plugin import containment (UBP-009, V-CC-1)
// ---------------------------------------------------------------------------
//
// A workspace trust grant (./workspace-trust.ts) is a hash of the plugin's
// folder. It only means "the code that runs is the code that was reviewed" if
// nothing the plugin executes lives OUTSIDE that folder — otherwise a
// `git pull` that edits `<repo>/lib/x.js`, imported by a trusted
// `.ethos/plugins/helper/index.js` as `../../../lib/x.js`, runs new code with
// the grant still "trusted".
//
// Hashing the import graph instead is not sound: `import()` and `require()`
// take computed specifiers, so the graph is only known once the code runs. So
// the loader CONTAINS it: before a trusted workspace plugin is imported, its
// real folder is registered here, and a module-resolution hook refuses every
// resolution FROM a module inside a registered folder TO a file outside it —
// relative, absolute and bare specifiers alike (a bare dependency hoisted to
// `<cwd>/node_modules`, or a pnpm sibling, is workspace code the grant does not
// cover either). `node:` builtins and `data:` URLs (whose source is in the
// importing, hashed file) resolve normally. The hook is synchronous and
// in-thread (`module.registerHooks`), so it sees static imports during linking
// — before any of the graph evaluates — as well as dynamic `import()` and CJS
// `require()` at call time. Resolution is by real path (Node's default), so a
// symlink inside the folder that points outside it is refused as well.
//
// Consequence: a trusted workspace plugin must be self-contained — its code and
// dependencies inside its folder (a nested `node_modules/` is part of the hash,
// `hashPluginTree`). Pinned by `__tests__/workspace-import-guard.test.ts`.
//
// Raw `node:fs` (`realpathSync`) — extensions/plugin-loader is on the
// no-raw-fs prefix allowlist; this resolves a module path, not ~/.ethos state.
// ---------------------------------------------------------------------------

import { realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const guardedRoots = new Set<string>();
let installed = false;
let onRefusal: ((message: string) => void) | undefined;

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function guardedRootOf(path: string): string | undefined {
  for (const root of guardedRoots) if (isInside(root, path)) return root;
  return undefined;
}

function filePath(url: string | undefined): string | undefined {
  if (!url?.startsWith('file:')) return undefined;
  try {
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
}

/**
 * The containment decision for one resolution: an error message when a module
 * inside a guarded folder resolved `specifier` to a file outside that folder,
 * otherwise `null`. Exported for tests.
 */
export function workspaceImportRefusal(
  specifier: string,
  parentURL: string | undefined,
  resolvedURL: string,
): string | null {
  const parent = filePath(parentURL);
  if (!parent) return null;
  const root = guardedRootOf(parent);
  if (!root) return null;
  if (resolvedURL.startsWith('node:') || resolvedURL.startsWith('data:')) return null;
  const target = filePath(resolvedURL);
  if (target && isInside(root, target)) return null;
  return `Workspace plugin at ${root} may not import "${specifier}" (resolves to ${target ?? resolvedURL}, outside the plugin folder): its trust grant covers only files inside that folder. Vendor the dependency into the folder and run \`ethos plugin trust\` again.`;
}

/**
 * Register `dir` as a trusted workspace plugin folder whose module graph must
 * stay inside it, installing the process-wide resolve hook on first use.
 * `refused` is told about each refusal (the loader logs it). Call BEFORE
 * importing the plugin's entry.
 */
export function guardWorkspacePluginImports(
  dir: string,
  refused?: (message: string) => void,
): void {
  guardedRoots.add(realpathSync(dir));
  if (refused) onRefusal = refused;
  if (installed) return;
  installed = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      const refusal = workspaceImportRefusal(specifier, context.parentURL, result.url);
      if (refusal) {
        onRefusal?.(refusal);
        throw new Error(refusal);
      }
      return result;
    },
  });
}

/** Tests only: forget every guarded folder (the hook itself stays installed). */
export function resetWorkspaceImportGuardForTests(): void {
  guardedRoots.clear();
  onRefusal = undefined;
}
