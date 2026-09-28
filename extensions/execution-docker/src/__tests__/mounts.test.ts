// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal substitution tokens (`${ETHOS_HOME}` etc.) resolved at runtime.
//
// Containment 3a, OS layer: the personality's own definition is mounted
// read-only in the container, with the asset folder `ownDir/files` rw beneath
// it. This is the half of `writeDeny` a terminal inside the sandbox cannot
// route around — `echo x >> toolset.yaml` gets "Read-only file system".

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExecutionBackendConfig,
  Logger,
  PersonalityConfig,
  SecretsResolver,
} from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerExecutionBackend } from '../index';

const ETHOS_HOME = '/home/tester/.ethos';
const CWD = '/work/project';
const OWN = `${ETHOS_HOME}/personalities/bob`;

const secrets: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};
const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

// `foldsCase` pins the host's case sensitivity (the backend's sixth
// constructor argument) so the Linux layout is asserted on every platform.
function modes(
  reach?: PersonalityConfig['fs_reach'],
  foldsCase = false,
  cwd = CWD,
): Map<string, 'ro' | 'rw'> {
  const config: ExecutionBackendConfig = {
    images: { default: 'x@sha256:abc' },
    substitutionVars: { ethosHome: ETHOS_HOME, cwd },
  };
  const be = new DockerExecutionBackend(
    { config, secrets, logger },
    async () => false,
    undefined,
    undefined,
    undefined,
    () => foldsCase,
  );
  const p = { id: 'bob', name: 'bob', fs_reach: reach } as unknown as PersonalityConfig;
  return new Map(be.mountsFor(p).map((m) => [m.hostPath, m.mode]));
}

describe('mountsFor — the personality definition is read-only', () => {
  it('default personality: ownDir is ro, ownDir/files is rw, cwd stays rw', () => {
    const m = modes(undefined);
    expect(m.get(OWN)).toBe('ro');
    expect(m.get(`${OWN}/files`)).toBe('rw');
    expect(m.get(CWD)).toBe('rw');
  });

  it("declared write: ['${ETHOS_HOME}/'] mounts ETHOS_HOME ro with a ro ownDir child", () => {
    const m = modes({ write: ['${ETHOS_HOME}/'] });
    expect(m.get(ETHOS_HOME)).toBe('ro');
    expect(m.get(OWN)).toBe('ro');
    expect(m.get(`${OWN}/files`)).toBe('rw');
  });

  it('a declared rw mount at a definition entry is downgraded to ro', () => {
    const m = modes({ write: ['${ETHOS_HOME}/personalities/${self}/skills/', '/data/out'] });
    expect(m.get(`${OWN}/skills`)).toBe('ro');
    expect(m.get('/data/out')).toBe('rw');
  });

  it('a write reach that does not cover ownDir adds no definition mounts', () => {
    const m = modes({ read: ['/data/in'], write: ['/data/out'] });
    expect(m.has(OWN)).toBe(false);
    expect(m.has(`${OWN}/files`)).toBe(false);
  });
});

// plan personality-memory-boundary G2-pre B, OS layer: under a write reach
// that spans the state dir, EVERY personality's definition and `learning/` are
// read-only in the container — the half of the storage-fs definition floor and
// the `learning` deny a shell inside the sandbox cannot route around.
describe('mountsFor — every personality definition and learning/ are read-only', () => {
  const PERSONALITIES = `${ETHOS_HOME}/personalities`;
  const LEARNING = `${ETHOS_HOME}/learning`;

  it("write: ['${ETHOS_HOME}/'] mounts personalities/ and learning/ ro, own files/ stays rw", () => {
    const m = modes({ write: ['${ETHOS_HOME}/'] });
    expect(m.get(ETHOS_HOME)).toBe('ro');
    expect(m.get(PERSONALITIES)).toBe('ro');
    expect(m.get(LEARNING)).toBe('ro');
    expect(m.get(OWN)).toBe('ro');
    expect(m.get(`${OWN}/files`)).toBe('rw');
  });

  it("write: ['${ETHOS_HOME}/personalities/'] is downgraded, but the caller keeps its files/", () => {
    const m = modes({ write: ['${ETHOS_HOME}/personalities/'] });
    expect(m.get(PERSONALITIES)).toBe('ro');
    expect(m.get(`${OWN}/files`)).toBe('rw');
    expect(m.has(LEARNING)).toBe(false);
  });

  it("a declared rw mount at another personality's directory or definition entry is ro", () => {
    const m = modes({
      write: [
        '${ETHOS_HOME}/personalities/alice/',
        '${ETHOS_HOME}/personalities/carol/toolset.yaml',
        '${ETHOS_HOME}/learning/candidates/',
      ],
    });
    expect(m.get(`${PERSONALITIES}/alice`)).toBe('ro');
    expect(m.get(`${PERSONALITIES}/carol/toolset.yaml`)).toBe('ro');
    expect(m.get(`${LEARNING}/candidates`)).toBe('ro');
  });

  it('a reach that does not span the state dir adds neither mount', () => {
    const m = modes(undefined);
    expect(m.has(PERSONALITIES)).toBe(false);
    expect(m.has(LEARNING)).toBe(false);
  });
});

// verification round A1/A6 — case variants. The floor folds case on every
// host; on a case-insensitive host (macOS/Windows Docker Desktop) a rw mount
// that CONTAINS a read-only guard is itself downgraded, because
// `<rw>/.ETHOS/personalities/…` reaches the same host file through the rw
// parent and never meets the ro mount.
describe('mountsFor — case variants', () => {
  const PERSONALITIES = `${ETHOS_HOME}/personalities`;

  it('floors a declared rw case variant of a definition entry or learning/ on every host', () => {
    for (const foldsCase of [false, true]) {
      const m = modes(
        {
          write: [
            '${ETHOS_HOME}/personalities/carol/TOOLSET.yaml',
            '${ETHOS_HOME}/personalities/carol/Soul.md',
            '${ETHOS_HOME}/LEARNING/',
            '${ETHOS_HOME}/personalities/BOB/',
          ],
        },
        foldsCase,
      );
      expect(m.get(`${PERSONALITIES}/carol/TOOLSET.yaml`)).toBe('ro');
      expect(m.get(`${PERSONALITIES}/carol/Soul.md`)).toBe('ro');
      expect(m.get(`${ETHOS_HOME}/LEARNING`)).toBe('ro');
      // A case variant of the caller's own directory is floored, never exempted.
      expect(m.get(`${PERSONALITIES}/BOB`)).toBe('ro');
    }
  });

  it('case-insensitive host: a rw state dir or ancestor becomes ro, own files/ stays rw', () => {
    const m = modes({ write: ['${ETHOS_HOME}/'] }, true);
    expect(m.get(ETHOS_HOME)).toBe('ro');
    expect(m.get(PERSONALITIES)).toBe('ro');
    expect(m.get(`${ETHOS_HOME}/learning`)).toBe('ro');
    expect(m.get(`${OWN}/files`)).toBe('rw');

    const fromHome = modes(undefined, true, '/home/tester');
    expect(fromHome.get('/home/tester')).toBe('ro');
    expect(fromHome.get(`${OWN}/files`)).toBe('rw');
  });

  it('case-sensitive host: a rw state dir ancestor becomes ro too (verification round G4)', () => {
    const m = modes(undefined, false, '/home/tester');
    expect(m.get('/home/tester')).toBe('ro');
    expect(m.get(`${OWN}/files`)).toBe('rw');
  });

  it('case-insensitive host: a rw mount beside the state dir is untouched', () => {
    const m = modes({ write: ['/data/out'] }, true);
    expect(m.get('/data/out')).toBe('rw');
  });
});

// Verification round F7 — the global `skills/` and `commands/` are definition
// too: read-only under a write reach that spans the state dir, and a declared
// rw mount inside one is downgraded.
describe('mountsFor — global skills/ and commands/ are read-only', () => {
  it("write: ['${ETHOS_HOME}/'] mounts skills/ and commands/ ro", () => {
    const m = modes({ write: ['${ETHOS_HOME}/'] });
    expect(m.get(`${ETHOS_HOME}/skills`)).toBe('ro');
    expect(m.get(`${ETHOS_HOME}/commands`)).toBe('ro');
  });

  it('a declared rw mount inside skills/ or commands/ is downgraded', () => {
    const m = modes({ write: ['${ETHOS_HOME}/skills/mine/', '${ETHOS_HOME}/Commands/'] });
    expect(m.get(`${ETHOS_HOME}/skills/mine`)).toBe('ro');
    expect(m.get(`${ETHOS_HOME}/Commands`)).toBe('ro');
  });
});

// Verification round F12 — every state dir is judged, not only this backend's
// `ethosHome`: `ETHOS_STATE_DIR` (and `~/.ethos`) get the same read-only guards
// and the same case-insensitive downgrade.
describe('mountsFor — every state dir, not only ethosHome', () => {
  let tmp: string | undefined;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  function otherStateDir(): { root: string; state: string } {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ethos-docker-state-')));
    const state = join(tmp, 'other-state');
    mkdirSync(join(state, 'personalities'), { recursive: true });
    mkdirSync(join(state, 'learning'), { recursive: true });
    vi.stubEnv('ETHOS_STATE_DIR', state);
    return { root: tmp, state };
  }

  it('guards an existing ETHOS_STATE_DIR under a rw cwd, and skips guards that do not exist', () => {
    const { root, state } = otherStateDir();
    const m = modes(undefined, false, root);
    expect(m.get(root)).toBe('ro');
    expect(m.get(join(state, 'personalities'))).toBe('ro');
    expect(m.get(join(state, 'learning'))).toBe('ro');
    // Not on the host: not bound (Docker would create it as root).
    expect(m.has(join(state, 'skills'))).toBe(false);
  });

  it('case-insensitive host: a rw mount containing ETHOS_STATE_DIR becomes ro', () => {
    const { root } = otherStateDir();
    const m = modes(undefined, true, root);
    expect(m.get(root)).toBe('ro');
  });

  it('floors a declared rw mount at a definition entry under ETHOS_STATE_DIR', () => {
    const { state } = otherStateDir();
    const m = modes({ write: [join(state, 'personalities', 'carol', 'toolset.yaml')] });
    expect(m.get(join(state, 'personalities', 'carol', 'toolset.yaml'))).toBe('ro');
  });
});

// Verification round G4 — the ro guards name only the definition entries, so a
// rw mount that IS a state dir or contains one is downgraded on EVERY host:
// otherwise `config.yaml`, `constitution.yaml`, `evolve-config.json`,
// `scripts/`, `cron/jobs.json` and the rest stay writable from a shell.
describe('mountsFor — a rw mount holding a state dir is read-only on every host', () => {
  for (const foldsCase of [false, true]) {
    it(`cwd at or above ETHOS_HOME is ro, own files/ stays rw (foldsCase=${foldsCase})`, () => {
      for (const cwd of [ETHOS_HOME, '/home/tester']) {
        const m = modes(undefined, foldsCase, cwd);
        expect([cwd, m.get(cwd)]).toEqual([cwd, 'ro']);
        expect(m.get(`${OWN}/files`)).toBe('rw');
      }
    });
  }

  it('a declared rw case variant of the state dir is ro on a case-sensitive host too', () => {
    const m = modes({ write: ['/home/tester/.ETHOS/'] }, false);
    expect(m.get('/home/tester/.ETHOS')).toBe('ro');
  });

  it('a rw mount below the state dir or beside it keeps its mode', () => {
    const m = modes({ write: ['/data/out', '${ETHOS_HOME}/personalities/${self}/files/'] });
    expect(m.get('/data/out')).toBe('rw');
    expect(m.get(`${OWN}/files`)).toBe('rw');
  });

  it('warns once per downgraded mount, not on every mountsFor', () => {
    const warn = vi.fn();
    const warnLogger: Logger = { ...logger, warn, child: () => warnLogger };
    const be = new DockerExecutionBackend(
      {
        config: {
          images: { default: 'x@sha256:abc' },
          substitutionVars: { ethosHome: ETHOS_HOME, cwd: '/home/tester' },
        },
        secrets,
        logger: warnLogger,
      },
      async () => false,
      undefined,
      undefined,
      undefined,
      () => false,
    );
    const p = { id: 'bob', name: 'bob' } as unknown as PersonalityConfig;
    be.mountsFor(p);
    be.mountsFor(p);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// Verification round G3 — macOS names a file by device + inode under `/.vol`
// and `/.resolve`, and `/.nofollow/<abs>` is `<abs>`: none of them is judged
// by the floors above, so a mount spelled that way is refused outright.
describe('mountsFor — macOS path aliases are refused', () => {
  for (const alias of ['/.vol/16777220/2/work', '/.RESOLVE/1/2', '/.nofollow/work/project']) {
    it(`refuses ${alias}`, () => {
      expect(() => modes({ write: [alias] })).toThrow(/forbidden host path/);
      expect(() => modes({ read: [alias] })).toThrow(/forbidden host path/);
    });
  }
});
