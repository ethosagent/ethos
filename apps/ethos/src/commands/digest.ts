// `ethos digest run [--email]` (Phase 3e) — a weekly digest that summarizes
// the trailing week of governed learning across all user personalities.
//
// `buildWeeklyDigest` is the pure, testable generator: given the personalities,
// a Storage, and a clock, it reads the per-personality learning sidecars and
// renders one Markdown report. It never touches `node:fs` and never hits the
// network — tests drive it with InMemoryStorage + fixture configs.
//
// `runDigest` is the CLI surface: it loads the registry, builds the digest,
// writes it to `~/.ethos/digests/<ISO-year>-W<ISO-week>.md`, and optionally
// emails it when an email platform + recipients are configured.
import { join } from 'node:path';
import { formatError, type PersonalityConfig, type Storage, toEthosError } from '@ethosagent/types';

function surface(err: unknown): never {
  process.stderr.write(`\n${formatError(toEthosError(err), { color: process.stderr.isTTY })}\n`);
  process.exit(1);
}

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

interface LearningLogEntry {
  revisionId: string;
  at: string;
  summary: string;
  evidenceRef: string;
  prevExpressionRef: string;
}

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

// ---------------------------------------------------------------------------
// CLI command
// ---------------------------------------------------------------------------

// Reusable entry shared by the `ethos digest` CLI command and the serve/gateway
// schedulers. Builds the digest for every user personality, writes it to
// `~/.ethos/digests/<ISO-week>.md` (overwrites — idempotent per week), and
// optionally emails it. Does NOT call `process.exit` — the cron callback wraps
// its own try/catch; the CLI wraps it with `surface`.
export async function runDigestOnce(
  config: import('../config').EthosConfig,
  opts?: { email?: boolean },
): Promise<void> {
  const { ethosDir } = await import('../config');
  const { getStorage } = await import('../wiring');
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');

  const storage = getStorage();
  const dir = ethosDir();
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: dir });
  await reg.loadFromDirectory(join(dir, 'personalities'));

  // Same target set as the nightly pass: user (mutable, non-builtin) ones.
  const targets = reg
    .describeAll()
    .filter((d) => !d.builtin)
    .map((d) => d.config);
  if (targets.length === 0) {
    console.log('No user personalities to build a digest for.');
    return;
  }

  const learningLogByPersonality: Record<
    string,
    Awaited<ReturnType<typeof reg.readLivingSoul>>['learningLog']
  > = {};
  for (const cfg of targets) {
    try {
      const soul = await reg.readLivingSoul(cfg.id);
      learningLogByPersonality[cfg.id] = soul.learningLog;
    } catch {
      learningLogByPersonality[cfg.id] = [];
    }
  }

  const now = new Date();
  const markdown = await buildWeeklyDigest({
    personalities: targets,
    storage,
    dataDir: dir,
    now,
    learningLogByPersonality,
  });

  const label = isoWeekLabel(now);
  const digestDir = join(dir, 'digests');
  await storage.mkdir(digestDir);
  const outPath = join(digestDir, `${label}.md`);
  await storage.writeAtomic(outPath, markdown);
  console.log(`Wrote weekly digest to ${outPath}`);

  if (opts?.email) {
    await emailDigest(config, markdown, label);
  }
}

export async function runDigest(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub !== 'run') {
    console.log('Usage: ethos digest run [--email]');
    return;
  }
  const wantEmail = argv.includes('--email');

  try {
    const { readConfig } = await import('../config');
    const { getStorage, getSecretsResolver } = await import('../wiring');

    const config = await readConfig(getStorage(), await getSecretsResolver());
    if (!config) {
      console.error('Run `ethos setup` first.');
      process.exit(1);
    }

    await runDigestOnce(config, { email: wantEmail });
  } catch (err) {
    surface(err);
  }
}

// Best-effort email delivery. Fully guarded: a missing email platform config
// or empty recipient list prints a notice and skips; a send failure logs and
// does not crash. Plain-markdown body — themed HTML styling is a deferred
// follow-up (see Phase 3e notes).
async function emailDigest(
  config: import('../config').EthosConfig,
  markdown: string,
  label: string,
): Promise<void> {
  const user = config.emailUser;
  const password = config.emailPassword;
  const smtpHost = config.emailSmtpHost;
  const recipients = config.weeklyDigest?.recipients ?? [];

  if (!user || !password || !smtpHost) {
    console.log(
      '--email: no email platform configured (emailSmtpHost/emailUser/emailPassword); skipping send.',
    );
    return;
  }
  if (recipients.length === 0) {
    console.log('--email: weeklyDigest.recipients is empty; skipping send.');
    return;
  }

  // Minimal local typing for the nodemailer subset we use — `@types/nodemailer`
  // is a devDependency of the email package, not visible from apps/ethos.
  interface MailTransporter {
    sendMail(opts: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
  }
  interface NodemailerModule {
    createTransport(opts: {
      host: string;
      port: number;
      secure: boolean;
      auth: { user: string; pass: string };
    }): MailTransporter;
  }
  // @ts-expect-error nodemailer ships no types here (@types/nodemailer is a
  // devDependency of @ethosagent/platform-email, not visible from apps/ethos).
  const nodemailerImport: unknown = await import('nodemailer');
  const nodemailer = nodemailerImport as NodemailerModule;
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: config.emailSmtpPort ?? 587,
    secure: config.emailSmtpPort === 465,
    auth: { user, pass: password },
  });

  for (const to of recipients) {
    try {
      await transporter.sendMail({
        from: user,
        to,
        subject: `Ethos weekly digest — ${label}`,
        text: markdown,
      });
      console.log(`--email: sent digest to ${to}`);
    } catch (err) {
      console.error(
        `--email: failed to send to ${to}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
