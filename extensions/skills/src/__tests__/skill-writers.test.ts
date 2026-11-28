// B4 — the writer set of live flat skills is pinned. `SkillHistory.writeAgentAuthored`
// is the lock's one choke point only while nothing else writes a skill path, so a
// new writer that bypasses it must fail here (plan `skill-history-and-lock.md` §9,
// "`writeHuman` trusts its caller").

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..', '..');

/** The files that build a live-skill path (`liveSkillDir`, `SkillsLibrary`) or promote one. */
const WRITER_FILES = [
  'extensions/skills/src/skills-library.ts',
  'extensions/learning-inbox/src/promote.ts',
  'extensions/skill-evolver/src/nightly-propose.ts',
  'extensions/skill-evolver/src/tools/skill-propose.ts',
  'extensions/skill-evolver/src/evolver.ts',
  'packages/wiring/src/learning-pipeline.ts',
];

const MUTATION =
  /\b(?:storage|this\.storage|deps\.storage|ctx\.storage)\.(?:write|writeAtomic|remove|rename|append)\(/;

/** The only mutations allowed outside `skill-history.ts`: candidate-record files, never a skill path. */
const CANDIDATE_RECORD = /priorSnapshotPath\(|promotionRecordPath\(/;

describe('live-skill writers', () => {
  it.each(WRITER_FILES)('%s never mutates a skill path directly', (rel) => {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (!MUTATION.test(line)) return;
      // A call may wrap: the path argument is then on the next line.
      const statement = `${line} ${lines[i + 1] ?? ''}`;
      if (CANDIDATE_RECORD.test(statement)) return;
      offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });

  it('promote.ts writes live skill bytes only through the injected ports', () => {
    const src = readFileSync(join(ROOT, 'extensions/learning-inbox/src/promote.ts'), 'utf8');
    expect(src).toContain('deps.writeSkill(');
    expect(src).toContain('deps.rollbackSkill(');
  });
});
