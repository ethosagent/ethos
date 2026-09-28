// Which files DEFINE a personality, and the write floor that keeps every turn
// off them (reach-and-containment 3a; plan personality-memory-boundary G2-pre B).
//
// Lives here, not in `@ethosagent/core` or `@ethosagent/storage-fs`, because
// both boundary copies need it and core may not import storage-fs at runtime
// (`packages/core/src/scoped/scoped-fs.ts`, ARCHITECTURE.md §II). Pure and
// dependency-free like ./memory-paths.ts: string operations only, no
// `node:path`. Callers pass ABSOLUTE, already-resolved paths (both boundaries
// `resolve()` before asking); a `..` segment is not interpreted here.
//
// Every comparison is case- and normalization-folded (`foldForDeny`,
// ./deny-fold.ts): on a case-insensitive file system `Toolset.yaml` IS
// `toolset.yaml` and `~/.ETHOS` IS `~/.ethos`, and this module only answers
// deny questions, so folding can only refuse more. State dirs are matched
// lexically; a caller passes every form it knows (`ethosStateDirs` in
// packages/storage-fs/src/sensitive-paths.ts adds each dir's realpath), and
// both boundaries also judge the realpath of the target.

import { foldForDeny } from './deny-fold';

/**
 * The entries directly under a personality's directory that DEFINE it:
 * who it is (`SOUL.md`, `ETHOS.md`), what it may do (`toolset.yaml`,
 * `mcp.yaml`, `tools.yaml`), how it is configured (`config.yaml`), and the
 * skills it carries (`skills/`, a directory — the trailing slash makes it a
 * prefix). An agent turn must never change these: the registry hot-reloads
 * them on mtime, so a turn that could write `toolset.yaml` could grant itself
 * (or any other personality) any tool on its next turn.
 *
 * It must cover every path `FilePersonalityRegistry.loadOne` fingerprints
 * (`extensions/personalities/src/index.ts`) — those are the files whose change
 * alters the loaded personality. `ETHOS.md` is on top of that list: it is not
 * fingerprinted, but it is identity text shipped beside `SOUL.md`. So are
 * `.expression-history/`, whose snapshots `FilePersonalityRegistry.revertExpression`
 * writes back into `SOUL.md` (a turn that could plant one could choose what a
 * revert restores), and `commands/`, the personality's slash-command templates
 * the CLI loads as prompts (verification rounds F3, F7). Their legitimate
 * writers — the registry's `evolveExpression`/`revertExpression` and the
 * operator — hold compose-time Storage.
 *
 * Deliberately absent: `MEMORY.md` / `USER.md` (content the agent is meant to
 * maintain; their writer is the memory provider, not the turn's scoped storage)
 * and `files/` (`personalityAssetDir`, the documented asset drop).
 *
 * Enforced two ways, both write-only:
 * - for the CALLING personality under whatever `ethosHome` its reach derives
 *   from, as a path list (`personalityWriteDeny` in `packages/core/src/fs-reach.ts`);
 * - for EVERY personality under every Ethos state dir, as the predicate
 *   {@link isPersonalityDefinitionPath} — the floor `ScopedStorage` applies on
 *   its own (`personalityDefinitionFloor`, packages/storage-fs/src/sensitive-paths.ts)
 *   and `ScopedFsImpl` receives injected (packages/core/src/scoped/scoped-fs.ts).
 *
 * `@ethosagent/core` re-exports this constant so existing importers
 * (`extensions/tools-file/src/index.ts`) compile unchanged.
 */
export const PERSONALITY_DEFINITION_ENTRIES: readonly string[] = [
  'SOUL.md',
  'config.yaml',
  'toolset.yaml',
  'mcp.yaml',
  'tools.yaml',
  'ETHOS.md',
  'skills/',
  'commands/',
  '.expression-history/',
];

/**
 * Entries directly under a STATE DIR that are definition too: the global
 * skills every personality loads (`<stateDir>/skills/`) and the global slash
 * commands (`<stateDir>/commands/`). Write-floored beside the per-personality
 * entries by {@link isPersonalityDefinitionPath} (verification round F7): a
 * turn that could write a global skill could plant instructions every
 * personality reads. Nothing writes them from a turn — skill installs, the
 * learning inbox's promotion and `ethos evolve` hold compose-time Storage.
 */
export const STATE_DIR_DEFINITION_ENTRIES: readonly string[] = ['skills/', 'commands/'];

/**
 * The state-dir directory holding team manifests: `<stateDir>/teams/<name>.yaml`
 * (or `.yml`) names a team's members and the personalities its work is
 * dispatched to, and the gateway and web API read it as operator config.
 * Write-floored by {@link isPersonalityDefinitionPath} (verification round
 * G7); the team's own directory beside it (`teams/<name>/` — its memory and
 * board) is not. Its legitimate writers — `scaffold_team`
 * (extensions/tools-personality-design) and `ethos team` — hold compose-time
 * Storage.
 */
export const TEAM_MANIFEST_DIR = 'teams';

/**
 * A boundary's write-floor predicate. `'access'` asks about the path itself;
 * `'subtree'` asks whether removing or renaming the path would move a
 * definition entry without naming it (a directory that CONTAINS one).
 * Same shape as `PrivatePathDeny` (./memory-paths.ts).
 */
export type DefinitionWriteFloor = (absPath: string, op: 'access' | 'subtree') => boolean;

/**
 * Segments of an absolute path with empty segments (doubled or trailing `/`)
 * dropped, each folded by `foldForDeny`.
 */
function segmentsOf(absPath: string): string[] {
  return foldForDeny(absPath)
    .split('/')
    .filter((s) => s.length > 0 && s !== '.');
}

/**
 * The segments of `absPath` below `root`, `[]` when they are the same path,
 * or `null` when `absPath` is not `root` and not under it.
 */
function segmentsBelow(absPath: string, root: string): string[] | null {
  const path = segmentsOf(absPath);
  const base = segmentsOf(root);
  if (path.length < base.length) return null;
  for (let i = 0; i < base.length; i++) if (path[i] !== base[i]) return null;
  return path.slice(base.length);
}

/** Entry names without the directory marker (`skills/` → `skills`), folded. */
const ENTRY_NAMES: readonly string[] = PERSONALITY_DEFINITION_ENTRIES.map((e) =>
  foldForDeny(e.endsWith('/') ? e.slice(0, -1) : e),
);

/** {@link STATE_DIR_DEFINITION_ENTRIES} without the directory marker, folded. */
const STATE_ENTRY_NAMES: readonly string[] = STATE_DIR_DEFINITION_ENTRIES.map((e) =>
  foldForDeny(e.slice(0, -1)),
);

/** True for a team manifest's file name (`<name>.yaml` / `.yml`), folded. */
function isTeamManifestName(name: string): boolean {
  return name.endsWith('.yaml') || name.endsWith('.yml');
}

/**
 * True when `absPath` is `<stateDir>/personalities/<any id>/<entry>` for an
 * entry in {@link PERSONALITY_DEFINITION_ENTRIES}, or `<stateDir>/<entry>` for
 * one in {@link STATE_DIR_DEFINITION_ENTRIES}, or lies below one (a file
 * under `skills/`), or is a team manifest `<stateDir>/teams/<name>.yaml`
 * ({@link TEAM_MANIFEST_DIR}). A predicate over the layout, not a list of
 * existing personalities, so a personality directory created mid-turn is
 * covered too.
 */
export function isPersonalityDefinitionPath(
  absPath: string,
  stateDirs: readonly string[],
): boolean {
  for (const stateDir of stateDirs) {
    const rel = segmentsBelow(absPath, stateDir);
    if (rel === null) continue;
    if (rel[0] !== undefined && STATE_ENTRY_NAMES.includes(rel[0])) return true;
    const manifest = rel[1];
    if (rel[0] === TEAM_MANIFEST_DIR && manifest !== undefined && isTeamManifestName(manifest)) {
      return true;
    }
    if (rel[0] !== 'personalities') continue;
    const entry = rel[2];
    if (entry !== undefined && ENTRY_NAMES.includes(entry)) return true;
  }
  return false;
}

/**
 * True when removing or renaming `absPath` would move a definition entry: it
 * is one itself, or it is a directory that can contain one — a state dir or
 * an ancestor of it, `personalities/`, a `personalities/<id>/` directory, or
 * `teams/`.
 */
export function containsPersonalityDefinitionPath(
  absPath: string,
  stateDirs: readonly string[],
): boolean {
  if (isPersonalityDefinitionPath(absPath, stateDirs)) return true;
  for (const stateDir of stateDirs) {
    if (segmentsBelow(stateDir, absPath) !== null) return true;
    const rel = segmentsBelow(absPath, stateDir);
    if (rel !== null && rel[0] === 'personalities' && rel.length <= 2) return true;
    if (rel !== null && rel[0] === TEAM_MANIFEST_DIR && rel.length === 1) return true;
  }
  return false;
}

/**
 * The boundary predicate over `stateDirs`: `'access'` →
 * {@link isPersonalityDefinitionPath}, `'subtree'` →
 * {@link containsPersonalityDefinitionPath}. Consulted for WRITES only —
 * a definition stays readable.
 */
export function personalityDefinitionWriteFloor(
  stateDirs: readonly string[],
): DefinitionWriteFloor {
  const dirs = [...stateDirs];
  return (absPath, op) =>
    op === 'subtree'
      ? containsPersonalityDefinitionPath(absPath, dirs)
      : isPersonalityDefinitionPath(absPath, dirs);
}
