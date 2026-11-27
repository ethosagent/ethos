import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { isReachWithinAllowedRoots } from '@ethosagent/constitution';
import type { SourceEntry } from './config-schema';

/**
 * R5/R6: decide whether an initiative's `sources` may be read. A source is
 * either a bare kind (`web`, `memory`, ...) or `{ repo: '<path>' }`. Bare kinds
 * carry no path and pass the root and blocked checks; a repo path
 * must sit inside `readableRoots`, outside every `blocked` entry (and every
 * ancestor of one, so `~` cannot cover `~/.ssh`), and must not name an env,
 * key or certificate file. For an agent-origin draft each source must also be
 * covered by `parentSources` (a bare kind must be present in the parent; a repo
 * path must sit inside a parent repo path).
 *
 * Enforced by `InitiativeConfigService.save` (src/config-service.ts); pinned by
 * `__tests__/initiative-sources-roots.test.ts` (R5) and
 * `__tests__/initiative-draft-no-widen.test.ts` (R6).
 *
 * Limitation: paths are compared lexically (`~` expanded, `..` folded). A
 * symlink inside a root that points outside it is not resolved here.
 */

const CASE_FOLD = process.platform === 'darwin' || process.platform === 'win32';
const NO_VARS = { ethosHome: '', self: '', cwd: '' };

const key = (p: string): string => (CASE_FOLD ? p.toLowerCase() : p);

const label = (e: SourceEntry): string => (typeof e === 'string' ? e : e.repo);

function expand(s: string): string | null {
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return resolve(homedir(), s.slice(2));
  return s.startsWith('/') ? resolve(s) : null;
}

function within(p: string, root: string): boolean {
  const a = key(p);
  const b = key(root);
  return a === b || a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`);
}

/** `**\/.env*`, `**\/*.pem`, `**\/id_*`, matched against every path segment. */
function secretFileMatch(abs: string): string | null {
  for (const seg of abs.split(sep)) {
    const s = CASE_FOLD ? seg.toLowerCase() : seg;
    if (s.startsWith('.env')) return '**/.env*';
    if (s.endsWith('.pem')) return '**/*.pem';
    if (s.startsWith('id_')) return '**/id_*';
  }
  return null;
}

export function checkSources(
  sources: readonly SourceEntry[],
  c: {
    readableRoots: readonly string[];
    blocked: readonly string[];
    parentSources?: readonly SourceEntry[];
  },
): { ok: true } | { ok: false; error: string } {
  const roots = c.readableRoots.flatMap((r) => expand(r) ?? []);
  const blocked = c.blocked.map((b) => resolve(b));
  for (const entry of sources) {
    if (typeof entry === 'string') continue;
    const src = entry.repo;
    const abs = expand(src);
    if (abs === null) {
      return { ok: false, error: `source "${src}" must be an absolute path or start with ~` };
    }
    if (roots.length === 0) {
      return {
        ok: false,
        error: `source "${src}" is a path but no readableRoots are configured (Settings → Automation → Initiatives)`,
      };
    }
    const inside = isReachWithinAllowedRoots(
      [abs],
      { filesystem: { allowedMountRoots: roots } },
      NO_VARS,
    );
    if (!inside || !roots.some((r) => within(abs, r))) {
      return { ok: false, error: `source "${src}" is outside readableRoots` };
    }
    const hit = blocked.find((b) => within(abs, b) || within(b, abs));
    if (hit !== undefined) {
      return { ok: false, error: `source "${src}" is blocked: it covers or is under ${hit}` };
    }
    const pattern = secretFileMatch(abs);
    if (pattern !== null) {
      return { ok: false, error: `source "${src}" is blocked: it matches ${pattern}` };
    }
  }
  if (c.parentSources !== undefined) {
    const parentKinds = new Set(c.parentSources.filter((p) => typeof p === 'string'));
    const parentPaths = c.parentSources.flatMap((p) =>
      typeof p === 'string' ? [] : (expand(p.repo) ?? []),
    );
    for (const entry of sources) {
      const abs = typeof entry === 'string' ? null : expand(entry.repo);
      const covered =
        typeof entry === 'string'
          ? parentKinds.has(entry)
          : abs !== null && parentPaths.some((p) => within(abs, p));
      if (!covered) {
        return {
          ok: false,
          error: `source "${label(entry)}" is not covered by the parent initiative's sources`,
        };
      }
    }
  }
  return { ok: true };
}
