import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { UniversalScanner } from '@ethosagent/skills';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import { BUNDLED_CODING_SKILL_IDS, bundledCodingSkillsSource } from '../index';

const SOURCE = bundledCodingSkillsSource();
describe('@ethosagent/skills-coding bundle', () => {
  it('points at an existing data directory', () => {
    const stat = statSync(SOURCE.dir);
    expect(stat.isDirectory()).toBe(true);
    expect(SOURCE.label).toBe('ethos-bundled');
  });
  it('exposes a SKILL.md for every advertised skill id', () => {
    const present = new Set(readdirSync(SOURCE.dir));
    for (const id of BUNDLED_CODING_SKILL_IDS) {
      expect(present.has(id), `missing skill directory: ${id}`).toBe(true);
      const skillMd = join(SOURCE.dir, id, 'SKILL.md');
      expect(statSync(skillMd).isFile(), `missing ${id}/SKILL.md`).toBe(true);
    }
  });
  it('every SKILL.md has the standard agentskills frontmatter', () => {
    for (const id of BUNDLED_CODING_SKILL_IDS) {
      const raw = readFileSync(join(SOURCE.dir, id, 'SKILL.md'), 'utf8');
      const { data } = matter(raw);
      expect(data.name, `${id} missing name`).toBeTruthy();
      expect(data.description, `${id} missing description`).toBeTruthy();
      expect(Array.isArray(data.tags), `${id} tags not array`).toBe(true);
      expect(Array.isArray(data.required_tools), `${id} required_tools not array`).toBe(true);
    }
  });
  it('every SKILL.md carries the ethos-specific extension block', () => {
    const validCategories = new Set([
      'planning-and-process',
      'quality-and-testing',
      'github-workflow',
      'delegation-and-orchestration',
      // framework-usage covers meta-skills (`native-mcp`, `ethos-skill-authoring`)
      // — guidance for using or extending Ethos itself rather than executing a
      // coding workflow. Added in lockstep with the first-party skills that
      // depend on it.
      'framework-usage',
    ]);
    for (const id of BUNDLED_CODING_SKILL_IDS) {
      const raw = readFileSync(join(SOURCE.dir, id, 'SKILL.md'), 'utf8');
      const { data } = matter(raw);
      const ethos = data.ethos;
      expect(ethos, `${id} missing ethos block`).toBeTruthy();
      expect(validCategories.has(ethos.category), `${id} category is ${ethos.category}`).toBe(true);
      expect(Array.isArray(ethos.default_personalities), `${id} default_personalities`).toBe(true);
    }
  });
  it('coding-agent ships the four CLI adapters', () => {
    const adaptersDir = join(SOURCE.dir, 'coding-agent', 'adapters');
    const present = new Set(readdirSync(adaptersDir));
    for (const adapter of ['claude-code.md', 'codex.md', 'opencode.md', 'pi.md']) {
      expect(present.has(adapter), `missing adapter: ${adapter}`).toBe(true);
    }
  });
  it('pi adapter documents the canonical one-shot invocation', () => {
    const piMd = readFileSync(join(SOURCE.dir, 'coding-agent', 'adapters', 'pi.md'), 'utf8');
    expect(piMd).toContain('pi -p');
  });
  it('universal scanner discovers all bundled skills via trustedFirstPartySources', async () => {
    const pool = await new UniversalScanner({
      // disable default community sources so we don't scan the real ~/.ethos
      // / ~/.claude tree on the dev machine running these tests
      sources: [],
      trustedFirstPartySources: [SOURCE],
    }).scan();
    for (const id of BUNDLED_CODING_SKILL_IDS) {
      expect(pool.has(`ethos-bundled/${id}`), `scanner missed ${id}`).toBe(true);
    }
  });
});
