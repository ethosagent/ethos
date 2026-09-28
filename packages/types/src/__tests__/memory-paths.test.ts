// plan personality-memory-boundary-and-self-amendment, G1-5 / D7 — the private
// memory path predicate the two file boundaries apply on a shared turn.
//
// This file pins the predicate's SEMANTICS with literal names. The name set is
// ALSO pinned against each memory backend's own exported constants in
// `packages/wiring/src/__tests__/memory-paths-backends.test.ts`: this package
// is zero-dependency, so its tests cannot resolve the backend packages.

import { describe, expect, it } from 'vitest';
import {
  containsPrivateMemoryPath,
  isPrivateMemoryPath,
  PRIVATE_MEMORY_BLOB_DIR,
  PRIVATE_MEMORY_DB_FILE,
  PRIVATE_MEMORY_FILE_NAMES,
  privateMemoryPathDeny,
  sharedTurnPathDeny,
} from '../memory-paths';

const HOME = '/home/u/.ethos';
const VAULT = '/notes/vault';
const roots = { stateDirs: [HOME], extraRoots: [VAULT] };
const own = `${HOME}/personalities/lean`;

describe('isPrivateMemoryPath — memory file names', () => {
  it('MEMORY.md and USER.md in a personality scope', () => {
    expect([...PRIVATE_MEMORY_FILE_NAMES].sort()).toEqual(['MEMORY.md', 'USER.md']);
    expect(isPrivateMemoryPath(`${own}/MEMORY.md`, roots)).toBe(true);
    expect(isPrivateMemoryPath(`${own}/USER.md`, roots)).toBe(true);
  });

  it('the history file, its monthly archives, its rotation snapshot and its blob dir', () => {
    expect(PRIVATE_MEMORY_BLOB_DIR).toBe('history-blobs');
    expect(isPrivateMemoryPath(`${own}/memory-history.jsonl`, roots)).toBe(true);
    expect(isPrivateMemoryPath(`${own}/memory-history-2026-01.jsonl`, roots)).toBe(true);
    expect(isPrivateMemoryPath(`${own}/memory-history.jsonl.rotating`, roots)).toBe(true);
    expect(isPrivateMemoryPath(`${own}/history-blobs/abc.md`, roots)).toBe(true);
  });

  it('the approval queue, tombstones, and the nightly pass’s meta and archive', () => {
    for (const name of [
      'memory-pending.jsonl',
      'memory-tombstones.jsonl',
      'memory-meta.json',
      'memory-archive.md',
    ]) {
      expect(isPrivateMemoryPath(`${own}/${name}`, roots), name).toBe(true);
    }
  });

  it('the vector store’s database, its SQLite siblings and its MEMORY.md export', () => {
    expect(PRIVATE_MEMORY_DB_FILE).toBe('memory.db');
    for (const name of ['memory.db', 'memory.db-wal', 'memory.db-shm', 'MEMORY.md']) {
      expect(isPrivateMemoryPath(`${HOME}/${name}`, roots), name).toBe(true);
    }
  });

  it('the global/team history and queue files at the state-dir root', () => {
    expect(isPrivateMemoryPath(`${HOME}/memory-history.jsonl`, roots)).toBe(true);
    expect(isPrivateMemoryPath(`${HOME}/memory-pending.jsonl`, roots)).toBe(true);
  });

  it('an atomic write’s temp sibling of a memory file', () => {
    expect(isPrivateMemoryPath(`${own}/MEMORY.md.tmp-1234`, roots)).toBe(true);
  });
});

describe('isPrivateMemoryPath — scopes and roots', () => {
  it('the whole users/ tree (user:<id> scope), the directory included', () => {
    expect(isPrivateMemoryPath(`${HOME}/users`, roots)).toBe(true);
    expect(isPrivateMemoryPath(`${HOME}/users/u1/USER.md`, roots)).toBe(true);
    expect(isPrivateMemoryPath(`${HOME}/users/u1/anything.txt`, roots)).toBe(true);
  });

  it('team memory directories (D4(a)), not the rest of a team directory', () => {
    expect(isPrivateMemoryPath(`${HOME}/teams/core/memory`, roots)).toBe(true);
    expect(isPrivateMemoryPath(`${HOME}/teams/core/memory/decisions.md`, roots)).toBe(true);
    expect(isPrivateMemoryPath(`${HOME}/teams/core/kanban.db`, roots)).toBe(false);
  });

  it('every path under an extra root (the vault), the root included', () => {
    expect(isPrivateMemoryPath(VAULT, roots)).toBe(true);
    expect(isPrivateMemoryPath(`${VAULT}/journal/2026.md`, roots)).toBe(true);
    expect(isPrivateMemoryPath('/notes/vaultish/x.md', roots)).toBe(false);
  });

  it('any personality, not only the caller’s own', () => {
    expect(isPrivateMemoryPath(`${HOME}/personalities/other/MEMORY.md`, roots)).toBe(true);
  });

  it('tolerates a doubled or trailing slash in the path or the root', () => {
    expect(isPrivateMemoryPath(`${HOME}//personalities/lean//MEMORY.md`, roots)).toBe(true);
    expect(isPrivateMemoryPath(`${own}/MEMORY.md`, { stateDirs: [`${HOME}/`] })).toBe(true);
  });
});

describe('isPrivateMemoryPath — what stays reachable', () => {
  it('the personality’s asset folder, Canvas templates and definition files', () => {
    expect(isPrivateMemoryPath(`${own}/files/logo.png`, roots)).toBe(false);
    expect(isPrivateMemoryPath(`${own}/ui/report.html`, roots)).toBe(false);
    expect(isPrivateMemoryPath(`${own}/SOUL.md`, roots)).toBe(false);
    expect(isPrivateMemoryPath(`${own}/toolset.yaml`, roots)).toBe(false);
  });

  it('a file NAMED like memory under files/ is not memory', () => {
    expect(isPrivateMemoryPath(`${own}/files/MEMORY.md`, roots)).toBe(false);
  });

  it('the personality directory itself and the state dir itself', () => {
    expect(isPrivateMemoryPath(own, roots)).toBe(false);
    expect(isPrivateMemoryPath(HOME, roots)).toBe(false);
  });

  it('paths outside every root, including a MEMORY.md in an unrelated project', () => {
    expect(isPrivateMemoryPath('/work/project/MEMORY.md', roots)).toBe(false);
    expect(isPrivateMemoryPath('/home/u/.ethos-other/users/x', roots)).toBe(false);
  });
});

describe('containsPrivateMemoryPath — remove/rename of a directory holding memory', () => {
  it('refuses the state dir, its ancestors, personalities/, a personality dir and a team dir', () => {
    for (const p of [
      '/home/u',
      HOME,
      `${HOME}/personalities`,
      own,
      `${HOME}/teams`,
      `${HOME}/teams/core`,
      '/notes',
    ]) {
      expect(containsPrivateMemoryPath(p, roots), p).toBe(true);
    }
  });

  it('allows a subtree with no memory in it', () => {
    expect(containsPrivateMemoryPath(`${own}/files`, roots)).toBe(false);
    expect(containsPrivateMemoryPath('/work/project', roots)).toBe(false);
  });
});

describe('privateMemoryPathDeny', () => {
  it('routes access and subtree questions to the matching predicate', () => {
    const deny = privateMemoryPathDeny(roots);
    expect(deny(`${own}/MEMORY.md`, 'access')).toBe(true);
    expect(deny(own, 'access')).toBe(false);
    expect(deny(own, 'subtree')).toBe(true);
  });
});

// Verification round A1 — case variants fail closed (on a case-insensitive
// file system they ARE the private files).
describe('isPrivateMemoryPath — case variants', () => {
  it.each([
    `${own}/memory.md`,
    `${own}/Memory.MD`,
    `${own}/user.md`,
    `${own}/MEMORY-history.jsonl`,
    `${own}/History-Blobs/a.md`,
    `${HOME}/Users/u1/USER.md`,
    `${HOME}/TEAMS/core/Memory/decisions.md`,
    `${HOME}/Memory.db-wal`,
    '/home/u/.ETHOS/personalities/lean/MEMORY.md',
    `${own.replace('personalities', 'PERSONALITIES')}/MEMORY.md`,
    '/notes/VAULT/journal.md',
  ])('%s is private', (path) => {
    expect(isPrivateMemoryPath(path, roots)).toBe(true);
  });

  it('a case-variant directory holding memory is refused for remove/rename', () => {
    expect(containsPrivateMemoryPath('/home/u/.ETHOS/Personalities/lean', roots)).toBe(true);
    expect(containsPrivateMemoryPath('/HOME/U', roots)).toBe(true);
  });

  it('non-memory files stay reachable in any case', () => {
    expect(isPrivateMemoryPath(`${own}/FILES/logo.png`, roots)).toBe(false);
    expect(isPrivateMemoryPath(`${own}/Soul.md`, roots)).toBe(false);
  });
});

// Verification round E4 — the shared-turn deny: nothing under a state dir but
// the turn's own files/, ui/, SOUL.md (read) and skills/ (read).
describe('sharedTurnPathDeny', () => {
  const H = '/home/u/.ethos';
  const deny = sharedTurnPathDeny({ stateDirs: [H], extraRoots: ['/vault'] }, 'lean');

  it('refuses every other state-dir path, for read and write', () => {
    for (const p of [
      H,
      `${H}/config.yaml`,
      `${H}/sessions.db`,
      `${H}/cron/output/job/2026.md`,
      `${H}/compaction/lean/x.md`,
      `${H}/kanban.db`,
      `${H}/personalities`,
      `${H}/personalities/lean`,
      `${H}/personalities/lean/config.yaml`,
      `${H}/personalities/lean/skills/s/SKILL.md`,
      `${H}/personalities/other/files/a.png`,
      `${H}/personalities/other/SOUL.md`,
    ]) {
      expect(deny(p, 'access', 'read'), p).toBe(true);
      expect(deny(p, 'access', 'write'), p).toBe(true);
    }
  });

  it('allows own files/ and ui/ both ways, SOUL.md and skills/ for reading only', () => {
    for (const p of [`${H}/personalities/lean/files/a.png`, `${H}/personalities/lean/ui/r.html`]) {
      expect(deny(p, 'access', 'read'), p).toBe(false);
      expect(deny(p, 'access', 'write'), p).toBe(false);
    }
    for (const p of [`${H}/personalities/lean/SOUL.md`, `${H}/skills/digest/SKILL.md`]) {
      expect(deny(p, 'access', 'read'), p).toBe(false);
      expect(deny(p, 'access', 'write'), p).toBe(true);
      // No kind → judged as a write (fail closed).
      expect(deny(p, 'access'), p).toBe(true);
    }
  });

  it('keeps private memory refused, inside files/ excepted as before, and the vault', () => {
    expect(deny('/vault/j.md', 'access', 'read')).toBe(true);
    expect(deny('/work/MEMORY.md', 'access', 'read')).toBe(false);
    expect(deny(`${H}/personalities/lean/MEMORY.md`, 'access', 'read')).toBe(true);
  });

  it('folds case and the macOS firmlink', () => {
    expect(deny('/HOME/U/.ETHOS/Config.yaml', 'access', 'read')).toBe(true);
    expect(deny(`/System/Volumes/Data${H}/config.yaml`, 'access', 'read')).toBe(true);
    expect(deny(`/System/Volumes/Data${H}/personalities/LEAN/Files/a.png`, 'access', 'read')).toBe(
      false,
    );
  });

  it('subtree: refuses removing anything it would refuse to write, or an ancestor', () => {
    expect(deny(`${H}/personalities/lean/files/old`, 'subtree')).toBe(false);
    expect(deny(`${H}/personalities/lean/files`, 'subtree')).toBe(false);
    expect(deny(`${H}/personalities/lean`, 'subtree')).toBe(true);
    expect(deny(`${H}/skills/digest`, 'subtree')).toBe(true);
    expect(deny('/home/u', 'subtree')).toBe(true);
    expect(deny('/work/project', 'subtree')).toBe(false);
  });

  it('an empty self allows nothing under personalities/', () => {
    const none = sharedTurnPathDeny({ stateDirs: [H] }, '');
    expect(none(`${H}/personalities/lean/files/a.png`, 'access', 'read')).toBe(true);
    expect(none(`${H}/skills/s/SKILL.md`, 'access', 'read')).toBe(false);
  });
});
