import { accentFor, DEFAULT_TOKENS } from '@ethosagent/design-tokens';
import type { InitiativeFileWire } from '@ethosagent/web-contracts';

export type InitiativeFilter = 'all' | 'human' | 'agent' | 'paused';

export const FILTERS: ReadonlyArray<{ key: InitiativeFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'human', label: 'Started by you' },
  { key: 'agent', label: 'Started by agent' },
  { key: 'paused', label: 'Paused' },
];

export function matchesFilter(
  item: { origin: 'human' | 'agent'; state: string },
  filter: InitiativeFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'paused') return item.state === 'paused';
  return item.origin === filter;
}

/**
 * Agent-started badge hue. DESIGN.md bans purple/violet, so there is no
 * "agent" token; the closest existing identity hue is the coach magenta from
 * the personality accent table, resolved through design-tokens, never a raw hex.
 */
export const AGENT_BADGE_ACCENT = accentFor(DEFAULT_TOKENS, 'coach');

export interface FileRow {
  key: string;
  label: string;
  /** Agent origin only. */
  agentOnly?: boolean;
  value: (f: InitiativeFileWire) => string[];
}

const NOT_SET = ['not set'];
const list = (xs: string[]): string[] => (xs.length > 0 ? xs : ['none']);
const one = (v: string | number | undefined): string[] => (v === undefined ? NOT_SET : [String(v)]);

/**
 * One labeled row per initiative-file key. A new key in INITIATIVE_FILE_FIELD_KEYS
 * fails 'every initiative file key is a labeled row' until it is added here.
 * `guidance` is rendered by GuidanceRows (mapping per line), so its value is empty.
 */
export const FILE_ROWS: readonly FileRow[] = [
  { key: 'id', label: 'ID', value: (f) => one(f.id) },
  { key: 'version', label: 'Version', value: (f) => one(f.version) },
  {
    key: 'origin',
    label: 'Started by',
    value: (f) => (f.origin === 'agent' ? ['Agent'] : ['You']),
  },
  { key: 'created_in', label: 'Created in', value: (f) => one(f.created_in) },
  { key: 'state', label: 'State', value: (f) => one(f.state) },
  { key: 'title', label: 'Title', value: (f) => one(f.title) },
  { key: 'outcome', label: 'Outcome', value: (f) => one(f.outcome) },
  {
    key: 'sources',
    label: 'Sources',
    value: (f) => list(f.sources.map((s) => (typeof s === 'string' ? s : `repo: ${s.repo}`))),
  },
  { key: 'exclude', label: 'Excluded', value: (f) => list(f.exclude) },
  { key: 'guidance', label: 'Guidance', value: () => [] },
  { key: 'autonomy.mode', label: 'Autonomy mode', value: (f) => one(f.autonomy.mode) },
  {
    key: 'autonomy.ask_above_usd',
    label: 'Ask above (USD)',
    value: (f) => one(f.autonomy.ask_above_usd),
  },
  {
    key: 'budget.usd_per_day',
    label: 'Budget per day (USD)',
    value: (f) => one(f.budget.usd_per_day),
  },
  {
    key: 'budget.usd_per_exploration',
    label: 'Budget per exploration (USD)',
    value: (f) => one(f.budget.usd_per_exploration),
  },
  {
    key: 'budget.max_open_explorations',
    label: 'Max open explorations',
    value: (f) => one(f.budget.max_open_explorations),
  },
  {
    key: 'timeline.explore_windows',
    label: 'Explore windows',
    value: (f) => list(f.timeline.explore_windows),
  },
  {
    key: 'timeline.window_minutes',
    label: 'Window length (min)',
    value: (f) => one(f.timeline.window_minutes),
  },
  {
    key: 'timeline.default_days',
    label: 'Default days',
    value: (f) => one(f.timeline.default_days),
  },
  { key: 'timeline.review_on', label: 'Review on', value: (f) => one(f.timeline.review_on) },
  { key: 'timeline.ends_on', label: 'Ends on', value: (f) => one(f.timeline.ends_on) },
  {
    key: 'delivery.owner_channel',
    label: 'Digest channel',
    value: (f) => one(f.delivery.owner_channel),
  },
  { key: 'delivery.digest_time', label: 'Digest time', value: (f) => one(f.delivery.digest_time) },
  { key: 'parent_id', label: 'Parent initiative', agentOnly: true, value: (f) => one(f.parent_id) },
  { key: 'notes', label: 'Agent notes', agentOnly: true, value: (f) => list(f.notes ?? []) },
];
