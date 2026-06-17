// `@ethosagent/digest` — the pure, testable weekly governed-learning digest
// generator. Given the personalities, a Storage, and a clock, it reads the
// per-personality learning sidecars and renders one Markdown report. It never
// touches `node:fs` and never hits the network — tests drive it with
// InMemoryStorage + fixture configs.
//
// CLI orchestration (registry loading, file write, email, process.exit) lives
// in `apps/ethos/src/commands/digest.ts`; the web-api `DigestService.generate`
// drives the same generator. Both import from here.
import { join } from 'node:path';
import type { LearningLogEntry, PersonalityConfig, Storage } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// ISO-week helpers
// ---------------------------------------------------------------------------

// ISO 8601 week-numbering year + week. Week 1 is the week containing the first
// Thursday of the year; weeks start Monday. Returns { year, week } where both
// are integers (week is 1..53).
export function isoWeek(date: Date): { year: number; week: number } {
  // Work in UTC to avoid local-timezone drift across the week boundary.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday of the current week determines the ISO year.
  const dayNum = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year, week };
}

// `2026-W07` — zero-padded week, used for the title and filename.
export function isoWeekLabel(date: Date): string {
  const { year, week } = isoWeek(date);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Sidecar readers (tolerant — a missing/malformed file is treated as empty)
// ---------------------------------------------------------------------------

interface JudgeStateLite {
  lowStreak: number;
  alignmentScore: number;
  signal: 'drift' | 'underspecified_soul' | null;
  at: string;
}

interface NightlyStateLite {
  windowEnd: string;
  completed: string[];
}

async function readJudgeState(
  storage: Storage,
  dataDir: string,
  id: string,
): Promise<JudgeStateLite | null> {
  const raw = await storage.read(
    join(dataDir, 'personalities', id, '.judge-history', 'state.json'),
  );
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const lastResult = obj.lastResult as Record<string, unknown> | undefined;
    if (!lastResult) return null;
    const alignmentScore = lastResult.alignmentScore;
    const signal = lastResult.signal;
    if (typeof alignmentScore !== 'number') return null;
    return {
      lowStreak: typeof obj.lowStreak === 'number' ? obj.lowStreak : 0,
      alignmentScore,
      signal: signal === 'drift' || signal === 'underspecified_soul' ? signal : null,
      at: typeof obj.at === 'string' ? obj.at : '',
    };
  } catch {
    return null;
  }
}

async function readNightlyState(
  storage: Storage,
  dataDir: string,
  id: string,
): Promise<NightlyStateLite | null> {
  const raw = await storage.read(join(dataDir, 'personalities', id, '.nightly-state.json'));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const completed = obj.completed;
    if (
      typeof obj.windowEnd !== 'string' ||
      !Array.isArray(completed) ||
      !completed.every((c) => typeof c === 'string')
    ) {
      return null;
    }
    return { windowEnd: obj.windowEnd, completed: completed as string[] };
  } catch {
    return null;
  }
}

// Count the 3d skill candidates currently parked in skills/.pending/<id>/.
async function readPendingSkillCandidates(
  storage: Storage,
  dataDir: string,
  id: string,
): Promise<string[]> {
  const entries = await storage.list(join(dataDir, 'skills', '.pending', id));
  return entries.filter((name) => name.endsWith('.md'));
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export interface WeeklyDigestInput {
  personalities: PersonalityConfig[];
  storage: Storage;
  dataDir: string;
  now: Date;
  windowDays?: number;
  // Learning-log entries keyed by personality id. The CLI supplies these via
  // `reg.readLivingSoul(id)`; tests supply fixtures directly. Optional —
  // an absent id is treated as having no entries.
  learningLogByPersonality?: Record<string, LearningLogEntry[]>;
}

export async function buildWeeklyDigest(input: WeeklyDigestInput): Promise<string> {
  const { personalities, storage, dataDir, now } = input;
  const windowDays = input.windowDays ?? 7;
  const windowStart = new Date(now.getTime() - windowDays * 86_400_000);
  const logByPersonality = input.learningLogByPersonality ?? {};

  const inWindow = (iso: string): boolean => {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return false;
    return t >= windowStart.getTime() && t <= now.getTime();
  };

  const label = isoWeekLabel(now);
  const sections: string[] = [];
  let totalEvolutions = 0;
  let totalCandidates = 0;
  let activePersonalities = 0;

  for (const cfg of personalities) {
    const id = cfg.id;
    const lines: string[] = [`## ${id}`, ''];

    const evolutions = (logByPersonality[id] ?? []).filter((e) => inWindow(e.at));
    const judge = await readJudgeState(storage, dataDir, id);
    const nightly = await readNightlyState(storage, dataDir, id);
    const candidates = await readPendingSkillCandidates(storage, dataDir, id);

    totalEvolutions += evolutions.length;
    totalCandidates += candidates.length;

    const hasActivity =
      evolutions.length > 0 ||
      judge !== null ||
      (nightly !== null && inWindow(nightly.windowEnd)) ||
      candidates.length > 0;

    if (!hasActivity) {
      lines.push('- No activity this week.', '');
      sections.push(lines.join('\n'));
      continue;
    }
    activePersonalities++;

    // Expressions evolved
    lines.push(`### Expressions evolved (${evolutions.length})`);
    if (evolutions.length === 0) {
      lines.push('- None.');
    } else {
      for (const e of evolutions) {
        lines.push(`- ${e.revisionId}: ${e.summary}`);
      }
    }
    lines.push('');

    // Judge alignment
    lines.push('### Judge alignment');
    if (judge === null) {
      lines.push('- No judge runs recorded.');
    } else {
      const pct = `${(judge.alignmentScore * 100).toFixed(0)}%`;
      const signal = judge.signal ? ` — signal: ${judge.signal}` : '';
      lines.push(`- Alignment ${pct}, low-streak ${judge.lowStreak}${signal}.`);
    }
    lines.push('');

    // Nightly passes
    lines.push('### Nightly passes');
    if (nightly === null) {
      lines.push('- No nightly state recorded.');
    } else {
      const steps = nightly.completed.length > 0 ? nightly.completed.join(', ') : 'none';
      lines.push(`- Last window ${nightly.windowEnd}; steps completed: ${steps}.`);
    }
    lines.push('');

    // New skill candidates (3d)
    lines.push(`### New skill candidates (${candidates.length})`);
    if (candidates.length === 0) {
      lines.push('- None pending.');
    } else {
      for (const name of candidates) {
        lines.push(`- ${name}`);
      }
    }
    lines.push('');

    sections.push(lines.join('\n'));
  }

  const header = [
    `# Weekly governed-learning digest — ${label}`,
    '',
    `Window: ${windowStart.toISOString()} → ${now.toISOString()} (${windowDays} days)`,
    '',
    '## Summary',
    '',
    `- Personalities reviewed: ${personalities.length} (${activePersonalities} with activity)`,
    `- Expressions evolved: ${totalEvolutions}`,
    `- New skill candidates: ${totalCandidates}`,
    '',
  ];

  return `${[...header, ...sections].join('\n').trimEnd()}\n`;
}
