// A bundled skill must not tell the agent to write under the Ethos state dir
// where its default `fs_reach` refuses the write. `write_file` reaches disk only
// through `ctx.scopedFs` (`fsOf` in extensions/tools-file/src/index.ts), whose
// write list for a personality that declares no `fs_reach` is
// `deriveFsReachPaths` → [its own personality dir, its workdir], minus
// `personalityWriteDeny`. So `~/.ethos/plans/…` or `~/.ethos/investigations/…`
// is refused, and a skill that says to write there fails the first time it is
// followed. Workspace scratch lives under `./.ethos-work/<kind>/` instead.
//
// The sibling `extensions/tools-terminal/src/__tests__/bundled-skills-guard.test.ts`
// covers shell blocks; this one scans the WHOLE of every skills/**/SKILL.md,
// prose and frontmatter included, because a write_file instruction is prose.
//
// LIMITATION: the scan cannot tell a write instruction from a sentence that
// merely names a location. Every `~/.ethos/<entry>` a skill names must either
// be writable under the default reach, or sit on the reviewed
// `NAMED_NOT_WRITTEN` list below — a location the skill describes for the
// operator (or for a CLI command) to write, never the agent. A new entry fails
// until someone reviews it.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveFsReachPaths } from '../fs-reach';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const SKILLS_ROOT = join(REPO, 'skills');

const HOME = '/home/tester';
const SELF = 'engineer';
const DEFAULT_REACH = deriveFsReachPaths(
  { id: SELF, name: SELF },
  { ethosHome: `${HOME}/.ethos`, self: SELF, cwd: '/work/project' },
);

/**
 * `~/.ethos/<entry>` locations bundled skills name but do not ask the agent to
 * write. Each is reviewed; adding one asserts the agent is never the writer.
 */
const NAMED_NOT_WRITTEN: Record<string, string> = {
  personalities: 'operator-owned; a personality definition is write-denied (personalityWriteDeny)',
  skills: 'user-level skill layout; read-only under the default reach',
  'mcp.json': 'operator config, written by `ethos mcp add` / `ethos personality mcp --attach`',
  secrets: 'the secrets resolver store, written by `ethos secrets` / the CLI',
  teams: 'team definitions, created by the operator (`ethos team create`)',
};

function skillFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : skillFiles(path);
    return e.name === 'SKILL.md' ? [path] : [];
  });
}

/** Every `~/.ethos/…` (or `$HOME` / `${HOME}` form) path in one file, as the rest after `.ethos/`. */
function stateDirPaths(markdown: string): string[] {
  const re = /(?:~|\$HOME|\$\{HOME\})\/\.ethos\/([^\s`'"),|]+)/g;
  return [...markdown.matchAll(re)].map((m) => m[1] ?? '').filter(Boolean);
}

function writableByDefault(rest: string): boolean {
  const abs = `${HOME}/.ethos/${rest}`;
  if (DEFAULT_REACH.writeDeny.some((deny) => abs === deny || abs.startsWith(deny))) return false;
  return DEFAULT_REACH.write.some((root) => abs.startsWith(root.endsWith('/') ? root : `${root}/`));
}

describe('bundled skills — ~/.ethos paths are reachable or reviewed', () => {
  const files = skillFiles(SKILLS_ROOT);

  it('finds the bundled skills', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('the default write reach excludes ~/.ethos outside the own personality dir', () => {
    expect(writableByDefault('plans/engineer/x.md')).toBe(false);
    expect(writableByDefault(`personalities/${SELF}/notes.md`)).toBe(true);
    expect(writableByDefault(`personalities/${SELF}/toolset.yaml`)).toBe(false);
  });

  it('every ~/.ethos/<entry> a skill names is writable by default or on the reviewed list', () => {
    const offenders = files.flatMap((file) =>
      stateDirPaths(readFileSync(file, 'utf8'))
        .filter((rest) => !writableByDefault(rest))
        .filter((rest) => !((rest.split('/')[0] ?? '') in NAMED_NOT_WRITTEN))
        .map((rest) => `${relative(REPO, file)}: ~/.ethos/${rest}`),
    );
    expect(offenders).toEqual([]);
  });
});
