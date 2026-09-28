// plan personality-memory-boundary-and-self-amendment, G2-pre B — the
// personality-definition write floor both file boundaries apply to every turn.
// This file pins the predicate's SEMANTICS; the boundaries' use of it is
// pinned in packages/storage-fs/src/__tests__/scoped-storage.test.ts and
// packages/core/src/__tests__/scoped-fs.test.ts.

import { describe, expect, it } from 'vitest';
import {
  containsPersonalityDefinitionPath,
  isPersonalityDefinitionPath,
  PERSONALITY_DEFINITION_ENTRIES,
  personalityDefinitionWriteFloor,
} from '../personality-definition';

const HOME = '/home/u/.ethos';
const ALT = '/srv/ethos-state';
const DIRS = [HOME, ALT];

describe('isPersonalityDefinitionPath', () => {
  it.each(PERSONALITY_DEFINITION_ENTRIES.map((e) => (e.endsWith('/') ? e.slice(0, -1) : e)))(
    'matches %s for ANY personality id under every state dir',
    (entry) => {
      for (const dir of DIRS) {
        expect(isPersonalityDefinitionPath(`${dir}/personalities/alice/${entry}`, DIRS)).toBe(true);
        expect(isPersonalityDefinitionPath(`${dir}/personalities/brand-new/${entry}`, DIRS)).toBe(
          true,
        );
      }
    },
  );

  it('matches anything below skills/', () => {
    expect(isPersonalityDefinitionPath(`${HOME}/personalities/a/skills/x/SKILL.md`, DIRS)).toBe(
      true,
    );
  });

  it('leaves memory, the asset folder and templates alone', () => {
    for (const rel of ['MEMORY.md', 'USER.md', 'files/toolset.yaml', 'ui/report.html']) {
      expect(isPersonalityDefinitionPath(`${HOME}/personalities/a/${rel}`, DIRS)).toBe(false);
    }
  });

  it('does not match outside personalities/<id>/ or outside a state dir', () => {
    expect(isPersonalityDefinitionPath(`${HOME}/toolset.yaml`, DIRS)).toBe(false);
    expect(isPersonalityDefinitionPath(`${HOME}/personalities/toolset.yaml`, DIRS)).toBe(false);
    expect(isPersonalityDefinitionPath('/elsewhere/personalities/a/toolset.yaml', DIRS)).toBe(
      false,
    );
    expect(isPersonalityDefinitionPath(`${HOME}/personalities/a/SOUL.md.bak`, DIRS)).toBe(false);
  });
});

describe('containsPersonalityDefinitionPath', () => {
  it('is true for a state dir, its ancestors, personalities/ and personalities/<id>/', () => {
    expect(containsPersonalityDefinitionPath(HOME, DIRS)).toBe(true);
    expect(containsPersonalityDefinitionPath('/home/u', DIRS)).toBe(true);
    expect(containsPersonalityDefinitionPath(`${HOME}/personalities`, DIRS)).toBe(true);
    expect(containsPersonalityDefinitionPath(`${HOME}/personalities/a`, DIRS)).toBe(true);
    expect(containsPersonalityDefinitionPath(`${HOME}/personalities/a/skills`, DIRS)).toBe(true);
  });

  it('is false for a sibling folder that holds no definition', () => {
    expect(containsPersonalityDefinitionPath(`${HOME}/personalities/a/files`, DIRS)).toBe(false);
    expect(containsPersonalityDefinitionPath(`${HOME}/learning`, DIRS)).toBe(false);
    expect(containsPersonalityDefinitionPath('/work/project', DIRS)).toBe(false);
  });
});

describe('personalityDefinitionWriteFloor', () => {
  it("routes 'access' and 'subtree' to the two predicates", () => {
    const floor = personalityDefinitionWriteFloor(DIRS);
    expect(floor(`${ALT}/personalities/a/toolset.yaml`, 'access')).toBe(true);
    expect(floor(`${ALT}/personalities/a`, 'access')).toBe(false);
    expect(floor(`${ALT}/personalities/a`, 'subtree')).toBe(true);
  });
});

// Verification round A1 — case variants fail closed (on a case-insensitive
// file system `Toolset.yaml` IS `toolset.yaml`).
describe('isPersonalityDefinitionPath — case variants', () => {
  it.each([
    `${HOME}/personalities/a/Toolset.yaml`,
    `${HOME}/personalities/a/TOOLSET.yaml`,
    `${HOME}/personalities/a/soul.md`,
    `${HOME}/personalities/a/Config.YAML`,
    `${HOME}/personalities/a/Skills/x/SKILL.md`,
    `${HOME}/PERSONALITIES/a/toolset.yaml`,
    '/home/u/.ETHOS/personalities/a/toolset.yaml',
    '/SRV/Ethos-State/personalities/a/mcp.yaml',
  ])('%s is a definition entry', (path) => {
    expect(isPersonalityDefinitionPath(path, DIRS)).toBe(true);
  });

  it('a case-variant ancestor is refused for remove/rename; files/ stays open', () => {
    expect(containsPersonalityDefinitionPath('/home/u/.ETHOS/Personalities/a', DIRS)).toBe(true);
    expect(isPersonalityDefinitionPath(`${HOME}/personalities/a/FILES/toolset.yaml`, DIRS)).toBe(
      false,
    );
  });
});

// Verification rounds F3/F7 — expression snapshots, per-personality slash
// commands, and the global skills/ and commands/ are definition too.
describe('isPersonalityDefinitionPath — snapshots, commands and global entries', () => {
  it.each([
    `${HOME}/personalities/a/.expression-history/expr-rev-1.md`,
    `${HOME}/personalities/a/commands/deploy.md`,
    `${HOME}/skills/x/SKILL.md`,
    `${HOME}/skills`,
    `${ALT}/commands/review.md`,
    `${HOME}/Skills/x/SKILL.md`,
    `${HOME}/COMMANDS/x.md`,
    `${HOME}/personalities/a/.Expression-History/expr-rev-2.md`,
  ])('%s is a definition entry', (path) => {
    expect(isPersonalityDefinitionPath(path, DIRS)).toBe(true);
  });

  it('leaves other state-dir entries to the always-deny floor, not this one', () => {
    for (const rel of ['cron/jobs.json', 'teams/t.yaml', 'skillsets/x', 'learning/audit.jsonl']) {
      expect(isPersonalityDefinitionPath(`${HOME}/${rel}`, DIRS)).toBe(false);
    }
  });
});
