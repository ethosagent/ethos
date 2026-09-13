import type {
  LearningCandidateView,
  LearningReplayReportView,
  LearningTimelineEntryView,
} from '@ethosagent/web-contracts';

// Pure derivations behind the Learning inbox (plan `trust-before-reach.md`
// Part 4, L-T9) — grouping, chip labels, verdict pills, Δ formatting, the
// unified diff and the links other screens use to point here. No React and no
// fetching, the same split `outbox.ts` and `scopeNav.ts` use.
//
// Everything below reads ONLY fields the `learning.*` RPCs return. Where the
// approved mockup showed something they do not carry — a candidate's human
// title, a session's title, whether a skill is shared across personalities —
// the wording here says what is known instead of inventing a field.

export type LearningStatus = LearningCandidateView['status'];
export type LearningVerdict = NonNullable<LearningCandidateView['verdict']>;
export type LearningReplayCase = LearningReplayReportView['cases'][number];
export type LearningReplayArm = NonNullable<LearningReplayCase['baseline']>;

/**
 * Statuses still waiting for a decision. Mirrors `AWAITING_DECISION` in
 * `extensions/learning-inbox/src/inbox.ts`, which is what actually refuses an
 * approve or a replay from any other status (`not_promotable`,
 * `not_replayable`) — this list only decides which buttons are drawn.
 */
export const LEARNING_WAITING: readonly LearningStatus[] = ['pending_replay', 'pending_review'];

/** Statuses a rejection may move out of — `REJECTABLE` in `inbox.ts`. */
export const LEARNING_REJECTABLE: readonly LearningStatus[] = [
  'pending_replay',
  'pending_review',
  'invalid',
  'stale',
];

/** What the sidebar counts: replayed, and waiting on a person. */
export const LEARNING_AWAITING_REVIEW: readonly LearningStatus[] = ['pending_review'];

export type LearningGroupKey = 'needs_review' | 'waiting_replay' | 'promoted' | 'closed';

export interface LearningGroup {
  key: LearningGroupKey;
  label: string;
  statuses: readonly LearningStatus[];
}

/**
 * The four list groups, in render order. Every wire status belongs to exactly
 * one — `learning.test.ts` pins that against `LearningCandidateStatusSchema`,
 * so a status added to the enum cannot quietly render nowhere. `invalid` and
 * `stale` can never promote, so they sit with the other closed candidates,
 * each carrying its own status word.
 */
export const LEARNING_GROUPS: readonly LearningGroup[] = [
  { key: 'needs_review', label: 'Needs review', statuses: ['pending_review'] },
  { key: 'waiting_replay', label: 'Waiting for replay', statuses: ['pending_replay'] },
  { key: 'promoted', label: 'Promoted', statuses: ['promoted'] },
  {
    key: 'closed',
    label: 'Rejected & rolled back',
    statuses: ['rejected', 'rolled_back', 'invalid', 'stale'],
  },
];

/** Candidates per group, keeping the list's newest-first order. */
export function groupCandidates(
  candidates: readonly LearningCandidateView[],
): Array<{ group: LearningGroup; items: LearningCandidateView[] }> {
  return LEARNING_GROUPS.map((group) => ({
    group,
    items: candidates.filter((c) => group.statuses.includes(c.status)),
  }));
}

/** New skill · Skill rewrite · Expression. */
export function kindLabel(candidate: Pick<LearningCandidateView, 'kind' | 'op'>): string {
  if (candidate.kind === 'expression') return 'Expression';
  return candidate.op === 'create' ? 'New skill' : 'Skill rewrite';
}

/** `fork` is the live post-turn fork, which the user knows as "Live". */
export const ORIGIN_LABELS: Record<LearningCandidateView['origin'], string> = {
  fork: 'Live',
  nightly: 'Nightly',
  chat: 'Chat',
  eval: 'Eval',
  web: 'Web',
  cli: 'CLI',
  legacy: 'Legacy',
};

export const STATUS_WORDS: Record<LearningStatus, string> = {
  pending_replay: 'waiting for replay',
  pending_review: 'needs review',
  promoted: 'promoted',
  rejected: 'rejected',
  rolled_back: 'rolled back',
  invalid: 'invalid',
  stale: 'stale',
};

export type PillTone = 'ok' | 'bad' | 'wait' | 'muted';

/** State is always an icon AND a word — never colour alone (DESIGN.md). */
export interface Pill {
  icon: '✓' | '✗' | '⏳' | '·';
  word: string;
  tone: PillTone;
}

/**
 * Cases the candidate held or improved on, out of the cases both arms ran —
 * the "7/8" in "Pass 7/8". The report carries no such field; it is derived
 * from each case's own `delta`.
 */
export function casesHeld(report: Pick<LearningReplayReportView, 'cases'>): {
  held: number;
  scored: number;
} {
  const scored = report.cases.filter((c) => c.delta !== null);
  return {
    held: scored.filter((c) => (c.delta ?? 0) >= 0).length,
    scored: scored.length,
  };
}

export function verdictPill(
  verdict: LearningVerdict | null,
  report?: Pick<LearningReplayReportView, 'cases'> | null,
): Pill {
  switch (verdict) {
    case 'pass': {
      if (!report) return { icon: '✓', word: 'Pass', tone: 'ok' };
      const { held, scored } = casesHeld(report);
      return { icon: '✓', word: scored > 0 ? `Pass ${held}/${scored}` : 'Pass', tone: 'ok' };
    }
    case 'regress':
      return { icon: '✗', word: 'Regress', tone: 'bad' };
    case 'incomplete':
      return { icon: '⏳', word: 'Incomplete', tone: 'wait' };
    default:
      return { icon: '·', word: 'Not run', tone: 'muted' };
  }
}

/** The list row's pill: the verdict, unless the status closed the candidate. */
export function rowPill(candidate: Pick<LearningCandidateView, 'status' | 'verdict'>): Pill {
  switch (candidate.status) {
    case 'rejected':
      return { icon: '✗', word: 'Rejected', tone: 'bad' };
    case 'rolled_back':
      return { icon: '✗', word: 'Rolled back', tone: 'muted' };
    case 'invalid':
      return { icon: '✗', word: 'Invalid', tone: 'bad' };
    case 'stale':
      return { icon: '✗', word: 'Stale', tone: 'muted' };
    default:
      return verdictPill(candidate.verdict);
  }
}

/** Below this, a score difference is "no change" — scores are two decimals. */
const FLAT_EPSILON = 0.005;

export type DeltaDirection = 'up' | 'down' | 'flat' | 'none';

export function deltaDirection(delta: number | null): DeltaDirection {
  if (delta === null) return 'none';
  if (Math.abs(delta) < FLAT_EPSILON) return 'flat';
  return delta > 0 ? 'up' : 'down';
}

/** `+0.50`, `−0.25` (a real minus sign), `0.00`, or `—` when an arm did not run. */
export function formatDelta(delta: number | null): string {
  const direction = deltaDirection(delta);
  if (delta === null || direction === 'none') return '—';
  if (direction === 'flat') return '0.00';
  return `${direction === 'up' ? '+' : '−'}${Math.abs(delta).toFixed(2)}`;
}

export function formatScore(score: number | null | undefined): string {
  return score === null || score === undefined ? '—' : score.toFixed(2);
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export function formatAge(iso: string, now: number = Date.now()): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * A name for the row. The candidate carries no title: a skill's frontmatter
 * `name:` is the closest thing, then its filename; an Expression has only its
 * personality, which the row already shows beside its mark.
 */
export function candidateTitle(
  candidate: Pick<LearningCandidateView, 'kind' | 'content' | 'destination'>,
): string {
  if (candidate.kind === 'expression') return 'Expression update';
  const name = frontmatterField(candidate.content, 'name');
  if (name) return name;
  const base = candidate.destination.split('/').pop() ?? candidate.destination;
  return base.replace(/\.md$/, '') || candidate.destination;
}

function frontmatterField(content: string, field: string): string | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  if (!block) return null;
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith(`${field}:`)) continue;
    const value = line
      .slice(field.length + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    return value || null;
  }
  return null;
}

export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** Above this many LCS cells the diff degrades to "all removed, all added". */
const MAX_DIFF_CELLS = 4_000_000;

function toLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * A unified line diff of what is live against what is proposed. `before` is
 * null when nothing is live yet (a new skill), which makes every line an add.
 */
export function unifiedDiff(before: string | null, after: string): DiffLine[] {
  const a = toLines(before ?? '');
  const b = toLines(after);
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ kind: 'del', text })),
      ...b.map((text): DiffLine => ({ kind: 'add', text })),
    ];
  }
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const left = a[i] ?? '';
    const right = b[j] ?? '';
    if (left === right) {
      out.push({ kind: 'same', text: left });
      i++;
      j++;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      out.push({ kind: 'del', text: left });
      i++;
    } else {
      out.push({ kind: 'add', text: right });
      j++;
    }
  }
  for (; i < n; i++) out.push({ kind: 'del', text: a[i] ?? '' });
  for (; j < m; j++) out.push({ kind: 'add', text: b[j] ?? '' });
  return out;
}

/**
 * The scorecard's caveats. The server puts the dry-run caveat in `limitations`
 * on every report (`REPLAY_LIMITATIONS`, `extensions/learning-inbox/src/
 * replay.ts`); if a report ever arrives without it the page still says it,
 * because every replay is a dry run (L-D4) and the caveat belongs with the
 * numbers, not in a doc.
 */
export const DRY_RUN_CAVEAT =
  'dry-run: tools stubbed — replay measures tool choice, arguments, voice and approach, not answers that depend on real tool output';

export function scorecardCaveats(report: Pick<LearningReplayReportView, 'limitations'>): string[] {
  const hasDryRun = report.limitations.some((l) => l.toLowerCase().includes('dry-run'));
  return hasDryRun ? [...report.limitations] : [DRY_RUN_CAVEAT, ...report.limitations];
}

/** `dry-run: tools stubbed — …` → a bold head and the explanation after it. */
export function splitCaveat(text: string): { head: string; rest: string } {
  const at = text.indexOf(' — ');
  const head = at === -1 ? text : text.slice(0, at);
  const rest = at === -1 ? '' : text.slice(at + 3);
  return { head: head.charAt(0).toUpperCase() + head.slice(1), rest };
}

export const STOP_REASON_TEXT: Record<
  NonNullable<LearningReplayReportView['stopReason']>,
  string
> = {
  budget: 'stopped at the cost budget',
  error: 'stopped on an error',
  insufficient_cases: 'not enough frozen cases to decide',
};

/** One Timeline line, from one row of the candidate's `audit.jsonl`. */
export function timelineText(entry: LearningTimelineEntryView): string {
  const by = entry.actor ? ` by ${entry.actor}` : '';
  const why = entry.reason ? ` — ${entry.reason}` : '';
  switch (entry.action) {
    case 'submitted':
      return `submitted${by}${why}`;
    case 'imported':
      return `imported from a legacy queue${why}`;
    case 'replay':
      return `replay recorded${entry.reason ? ` · run ${entry.reason}` : ''}`;
    case 'status': {
      const from = entry.from ? STATUS_WORDS[entry.from] : '—';
      const to = entry.to ? STATUS_WORDS[entry.to] : '—';
      const verdict = entry.verdict ? ` · ${entry.verdict}` : '';
      return `${from} → ${to}${verdict}${by}${why}`;
    }
    default:
      return `${entry.action}${by}${why}`;
  }
}

/**
 * Why Rollback is disabled, in the reader's words. The server's own reason is
 * always shown beside it; this is only the headline for the codes
 * `checkRollback` (`extensions/learning-inbox/src/promote.ts`) returns.
 */
export const ROLLBACK_HEADLINES: Record<string, string> = {
  live_edited: 'The live file was edited after promotion. Rolling back would discard that edit.',
  not_latest: 'A later Expression change is promoted. Roll that one back first.',
  no_record: 'There is no promotion record to roll back from.',
  not_promoted: 'Only a promoted change can be rolled back.',
};

/**
 * The candidate a Learning Log entry came from. `promote()` writes
 * `evidenceRef: learning:<candidateId>` on every Expression it promotes
 * (`extensions/learning-inbox/src/promote.ts`); older entries carry other refs
 * and have no candidate to link to.
 */
export function candidateIdFromEvidenceRef(ref: string): string | null {
  const match = /^learning:(.+)$/.exec(ref);
  return match?.[1] ?? null;
}

export function learningPath(filter: {
  candidate?: string;
  personality?: string;
  kind?: 'skill' | 'expression';
}): string {
  const params = new URLSearchParams();
  if (filter.personality) params.set('personality', filter.personality);
  if (filter.kind) params.set('kind', filter.kind);
  if (filter.candidate) params.set('candidate', filter.candidate);
  const query = params.toString();
  return query ? `/learning?${query}` : '/learning';
}

/** "3 changes waiting in Learning →", for the links that replaced the old queues. */
export function waitingLinkText(count: number | undefined, noun = 'change'): string {
  if (count === undefined) return 'Open Learning →';
  if (count === 0) return `No ${noun}s waiting in Learning →`;
  return `${count} ${count === 1 ? noun : `${noun}s`} waiting in Learning →`;
}
