// The `social-media/reddit-research` skill attaches to a personality by
// capability, not by name: `default_personalities` is empty (no built-in
// personality ships `reddit_search`, and `default-personality-reach.test.ts`
// would fail if it named one), so the ONLY thing that makes it appear
// alongside the Reddit tools is `required_tools: [reddit_search]` meeting
// `capabilityCheck` in ingest-filter.ts.
//
// That is a single frontmatter line holding up the whole "the skill shows up
// with the tool" behaviour. Widen `required_tools` to include `terminal` (the
// bundled script needs it) and the skill silently stops loading on every
// personality that has the Reddit tools but no shell. This drives the real
// scanner and the real `filterSkill` against the real on-disk SKILL.md so that
// regression fails a build.

import { FsStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig, Skill } from '@ethosagent/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { bundledSkillsSource } from '../bundled';
import { filterSkill } from '../ingest-filter';
import { UniversalScanner } from '../universal-scanner';

const QUALIFIED_NAME = 'ethos-bundled/social-media/reddit-research';

const personality: PersonalityConfig = { id: 'default', name: 'Default' };

let skill: Skill;

beforeAll(async () => {
  const pool = await new UniversalScanner({
    storage: new FsStorage(),
    // No default community sources — don't scan the dev machine's real
    // ~/.ethos / ~/.claude trees. Same reasoning as bundle.test.ts.
    sources: [],
    trustedFirstPartySources: [bundledSkillsSource()],
  }).scan();
  const found = pool.get(QUALIFIED_NAME);
  if (!found) throw new Error(`scanner did not discover ${QUALIFIED_NAME}`);
  skill = found;
});

describe('social-media/reddit-research attaches to reddit_search', () => {
  it('declares reddit_search as its only required tool', () => {
    expect(skill.required_tools).toEqual(['reddit_search']);
  });

  it('is excluded from a personality without reddit_search in reach', () => {
    const result = filterSkill(skill, personality, new Set(['web_search', 'terminal']));
    expect(result.include).toBe(false);
    expect(result.reason).toContain('reddit_search');
  });

  it('is included as soon as reddit_search is in reach', () => {
    const result = filterSkill(skill, personality, new Set(['reddit_search']));
    expect(result.include, result.reason).toBe(true);
  });
});
