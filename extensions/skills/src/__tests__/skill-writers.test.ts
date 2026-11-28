// B4 — the writer set of live flat skills. `SkillHistory.writeAgentAuthored` is the
// lock's one choke point only while nothing else writes a skill path, so a new writer
// that mutates one through Storage should fail here (plan `skill-history-and-lock.md` §9,
// "`writeHuman` trusts its caller").
//
// LIMITATION: this is a TEXT scan. It flags a Storage mutation (`write`, `writeAtomic`,
// `remove`, `rename`, `append`) whose call, or the two lines after it, names `liveSkillDir`,
// `skillPath`, a `skillsDir` variable or a `skills` path segment. A path built far from the
// call (a bare `dest` argument) is not caught, so this narrows the writer set; it does not
// prove it. The files below are the writers that are out of scope on purpose.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..', '..');
const SCAN_ROOTS = ['extensions', 'packages', 'apps'];

const MUTATION = /\.(?:write|writeAtomic|remove|rename|append)\(/;
const SKILL_PATH = /liveSkillDir|skillPath|skillsDir|SkillsDir|['"`/]skills['"`/]|skills\//;

/** Files allowed to mutate a skill path, with why. */
const ALLOWED: Record<string, string> = {
  'extensions/skills/src/skill-history.ts': 'the single writer (SkillHistory)',
};

/** Plan §8: raw-fs or bulk writers that are out of scope. They use `node:fs`, not Storage, so the scan cannot see them; listed so the omission is explicit. */
export const OUT_OF_SCOPE = [
  'extensions/skill-evolver/src/evolve-helpers.ts (ethos evolve archive, raw node:fs)',
  'apps/ethos/src/commands/skills.ts (hub install/update/remove of <slug>/SKILL.md directories)',
  'packages/wiring/src/backup/restore.ts (backup restore writes skill dirs wholesale)',
];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '__tests__', '.git'].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

export function skillPathMutations(text: string): number[] {
  const lines = text.split('\n');
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (!MUTATION.test(line)) return;
    if (SKILL_PATH.test([line, lines[i + 1] ?? '', lines[i + 2] ?? ''].join(' '))) hits.push(i + 1);
  });
  return hits;
}

describe('live-skill writers', () => {
  it('the scan recognises a skill-path mutation and ignores an unrelated one', () => {
    expect(skillPathMutations("await storage.write(join(skillsDir, 'a.md'), x);")).toEqual([1]);
    expect(skillPathMutations('await storage.writeAtomic(\n  liveSkillDir(a, b),\n  x);')).toEqual([
      1,
    ]);
    expect(skillPathMutations("await storage.write(join(dir, 'config.yaml'), x);")).toEqual([]);
  });

  it('no non-test source under extensions/, packages/ or apps/ mutates a skill path outside the allowlist', () => {
    const files = SCAN_ROOTS.flatMap((r) => sources(join(ROOT, r)));
    expect(files.length).toBeGreaterThan(500);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (rel in ALLOWED) continue;
      for (const line of skillPathMutations(readFileSync(file, 'utf8')))
        offenders.push(`${rel}:${line}`);
    }
    expect(offenders).toEqual([]);
  });

  it('promote.ts writes live skill bytes only through the injected ports', () => {
    const src = readFileSync(join(ROOT, 'extensions/learning-inbox/src/promote.ts'), 'utf8');
    expect(src).toContain('deps.writeSkill(');
    expect(src).toContain('deps.rollbackSkill(');
  });
});
