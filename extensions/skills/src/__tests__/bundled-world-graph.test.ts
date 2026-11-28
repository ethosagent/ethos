// The bundled `knowledge/world-graph` skill: it must parse through the real
// scanner and may only name tools that tools-world really registers.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { createWorldTools, WORLD_TOOL_NAMES } from '@ethosagent/tools-world';
import type { WorldToolPort } from '@ethosagent/world-service';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import { BUNDLED_SKILL_IDS, bundledSkillsSource } from '../bundled';
import { UniversalScanner } from '../universal-scanner';

const QUALIFIED_NAME = 'ethos-bundled/knowledge/world-graph';

async function scanSkill() {
  const pool = await new UniversalScanner({
    storage: new FsStorage(),
    sources: [],
    trustedFirstPartySources: [bundledSkillsSource()],
  }).scan();
  return pool.get(QUALIFIED_NAME);
}

describe('knowledge/world-graph', () => {
  it('world-graph is bundled and parses', async () => {
    expect(BUNDLED_SKILL_IDS).toContain('knowledge/world-graph');
    const skill = await scanSkill();
    expect(skill, `scanner did not discover ${QUALIFIED_NAME}`).toBeDefined();
    expect(skill?.required_tools).toEqual(['world_query']);
    expect(skill?.body).toContain('Graph or memory?');
    expect(skill?.body).toContain('Never');
  });

  it('every tool named in integrates_with is a world_* tool that tools-world registers', async () => {
    const raw = readFileSync(
      join(bundledSkillsSource().dir, 'knowledge/world-graph/SKILL.md'),
      'utf8',
    );
    const ethos = matter(raw).data.ethos as { integrates_with?: { tool: string }[] };
    const integrates = ethos.integrates_with ?? [];
    expect(integrates.length).toBe(WORLD_TOOL_NAMES.length);
    // The stub port is never called: tool construction only closes over it.
    const registered = new Set(createWorldTools({} as WorldToolPort).map((t) => t.name));
    for (const entry of integrates) {
      expect(entry.tool.startsWith('world_'), entry.tool).toBe(true);
      expect(registered.has(entry.tool), `${entry.tool} not registered`).toBe(true);
      expect(WORLD_TOOL_NAMES).toContain(entry.tool);
    }
  });
});
