// Shared landing-page personality data — single source for the orbit hero
// (speech bubbles + tool-call chips), the roster cards, and the CTA.

export type PersonalityId = 'researcher' | 'engineer' | 'reviewer';

export interface LandingPersonality {
  id: PersonalityId;
  accent: string;
  model: string;
  tagline: string;
  sample: string;
  // Speech-bubble quote for the orbit stage. Backtick spans render as <code>.
  quote: string;
  // Roster card copy: first-person soul line + supporting blurb.
  soulLine: string;
  soulBlurb: string;
  // Actual tool names from extensions/personalities/data/<id>/toolset.yaml
  tools: string[];
  // Subset used by the orbit hero's rising tool-call chips.
  flightTools: string[];
  // Subset shown as chips on the roster card.
  rosterTools: string[];
}

const researcher: LandingPersonality = {
  id: 'researcher',
  accent: '#4A9EFF',
  model: 'claude-fable-5',
  tagline: 'methodical · cites sources · flags uncertainty',
  sample:
    'There are three families. The first is dense embedding retrieval, used by most open-source vector stores.',
  quote:
    'There are three families of retrieval. I read the papers so you don’t have to — sources in the thread.',
  soulLine: `"I cite what I read and flag what I couldn't verify."`,
  soulBlurb: 'Deep dives, digests, and memory that compounds across sessions.',
  tools: [
    'web_search',
    'web_extract',
    'web_crawl',
    'read_file',
    'search_files',
    'memory_read',
    'memory_write',
    'session_search',
  ],
  flightTools: ['web_search', 'web_extract', 'memory_read', 'session_search'],
  rosterTools: ['web_search', 'web_extract', 'memory_write', 'session_search'],
};

const engineer: LandingPersonality = {
  id: 'engineer',
  accent: '#4ADE80',
  model: 'glm-5.2',
  tagline: 'terse · code-first · runs commands to verify',
  sample:
    'On it. Plan: move apps/tui/src/agent-bridge.ts to packages/agent-bridge, update tui imports.',
  quote: 'Patched `queue.ts:88`, ran the suite ×50. Green. Pushing.',
  soulLine: `"Ran it. Here's the output."`,
  soulBlurb: `Patches, tests, terminals. Verifies its own work before it tells you it's done.`,
  tools: [
    'terminal',
    'read_file',
    'write_file',
    'patch_file',
    'search_files',
    'web_search',
    'web_extract',
    'execute_code',
    'run_tests',
    'lint',
  ],
  flightTools: ['read_file', 'patch_file', 'run_tests', 'terminal'],
  rosterTools: ['terminal', 'patch_file', 'run_tests', 'lint'],
};

const reviewer: LandingPersonality = {
  id: 'reviewer',
  accent: '#F59E0B',
  model: 'gpt-5.6-sol',
  tagline: 'critical · evidence-based · always explains why',
  sample: 'Two real concerns. The token rotation logic at auth.ts:47 has a TOCTOU race.',
  quote:
    'Two real concerns. The token rotation at `auth.ts:47` has a TOCTOU race. Holding the merge.',
  soulLine: '"Two real concerns, with line numbers."',
  soulBlurb: 'Reads everything, writes nothing — the framework makes sure of it.',
  tools: ['read_file', 'search_files', 'session_search'],
  flightTools: ['read_file', 'search_files', 'session_search'],
  rosterTools: ['read_file', 'search_files', 'session_search'],
};

export const PERSONALITIES: LandingPersonality[] = [researcher, engineer, reviewer];

export const PERSONALITY_BY_ID: Record<PersonalityId, LandingPersonality> = {
  researcher,
  engineer,
  reviewer,
};

export const PERSONALITY_INDEX: Record<PersonalityId, number> = {
  researcher: 0,
  engineer: 1,
  reviewer: 2,
};
