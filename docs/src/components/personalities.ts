// Shared landing-page personality data — single source for the orbit hero,
// the call card, and the personality showcase plates.

export type PersonalityId = 'researcher' | 'engineer' | 'reviewer';

export interface LandingPersonality {
  id: PersonalityId;
  accent: string;
  model: string;
  tagline: string;
  sample: string;
  // Actual tool names from extensions/personalities/data/<id>/toolset.yaml
  tools: string[];
  // Subset used by the orbit hero's rising tool-call chips.
  flightTools: string[];
}

const researcher: LandingPersonality = {
  id: 'researcher',
  accent: '#4A9EFF',
  model: 'claude-fable-5',
  tagline: 'methodical · cites sources · flags uncertainty',
  sample:
    'There are three families. The first is dense embedding retrieval, used by most open-source vector stores.',
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
};

const engineer: LandingPersonality = {
  id: 'engineer',
  accent: '#4ADE80',
  model: 'glm-5.2',
  tagline: 'terse · code-first · runs commands to verify',
  sample:
    'On it. Plan: move apps/tui/src/agent-bridge.ts to packages/agent-bridge, update tui imports.',
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
};

const reviewer: LandingPersonality = {
  id: 'reviewer',
  accent: '#F59E0B',
  model: 'gpt-5.6-sol',
  tagline: 'critical · evidence-based · always explains why',
  sample: 'Two real concerns. The token rotation logic at auth.ts:47 has a TOCTOU race.',
  tools: ['read_file', 'search_files', 'session_search'],
  flightTools: ['read_file', 'search_files', 'session_search'],
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
