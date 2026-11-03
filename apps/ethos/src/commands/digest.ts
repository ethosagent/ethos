// `ethos digest run [--email]` (Phase 3e) — a weekly digest that summarizes
// the trailing week of governed learning across all user personalities.
//
// The pure, testable generator (`buildWeeklyDigest` + the ISO-week helpers)
// lives in `@ethosagent/digest` so both the CLI and the web-api can drive it.
//
// `runDigest` is the CLI surface: it loads the registry, builds the digest,
// writes it to `~/.ethos/digests/<ISO-year>-W<ISO-week>.md`, and optionally
// emails it when an email platform + recipients are configured.
import { join } from 'node:path';
import {
  buildWeeklyDigest,
  isoWeekLabel,
  waitingSkillNamesByPersonality,
} from '@ethosagent/digest';
import { formatError, toEthosError } from '@ethosagent/types';
import { sayFor, writeJson, writeJsonError } from '../json-output';

function surface(err: unknown): never {
  process.stderr.write(`\n${formatError(toEthosError(err), { color: process.stderr.isTTY })}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI command
// ---------------------------------------------------------------------------

// Reusable entry shared by the `ethos digest` CLI command and the serve/gateway
// schedulers. Builds the digest for every user personality, writes it to
// `~/.ethos/digests/<ISO-week>.md` (overwrites — idempotent per week), and
// optionally emails it. Does NOT call `process.exit` — the cron callback wraps
// its own try/catch; the CLI wraps it with `surface`.
//
// `opts.json` keeps stdout clean for the one JSON document `runDigest` prints:
// progress lines go to stderr and the outcome comes back as the return value.
export interface DigestEmailOutcome {
  /** Why nothing was sent: no email platform or no recipients. Null when a send was attempted. */
  skipped: string | null;
  sent: string[];
  failed: string[];
}

export interface DigestOutcome {
  /** False when there are no user personalities to build a digest for. */
  written: boolean;
  path: string | null;
  week: string | null;
  personalities: number;
  email: DigestEmailOutcome | null;
}

export async function runDigestOnce(
  config: import('@ethosagent/config').EthosConfig,
  opts?: { email?: boolean; json?: boolean },
): Promise<DigestOutcome> {
  const say = sayFor(opts?.json === true);
  const { ethosDir } = await import('@ethosagent/config');
  const { createCliLearningInbox, getStorage } = await import('../wiring');
  const { AWAITING_DECISION } = await import('@ethosagent/learning-inbox');
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
    say('No user personalities to build a digest for.');
    return { written: false, path: null, week: null, personalities: 0, email: null };
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

  // The candidate count is the learning inbox's, not a retired pending dir.
  const waiting = await (await createCliLearningInbox(config)).list({
    kind: 'skill',
    status: AWAITING_DECISION,
  });

  const now = new Date();
  const markdown = await buildWeeklyDigest({
    personalities: targets,
    storage,
    dataDir: dir,
    now,
    learningLogByPersonality,
    pendingSkillCandidatesByPersonality: waitingSkillNamesByPersonality(waiting),
  });

  const label = isoWeekLabel(now);
  const digestDir = join(dir, 'digests');
  await storage.mkdir(digestDir);
  const outPath = join(digestDir, `${label}.md`);
  await storage.writeAtomic(outPath, markdown);
  say(`Wrote weekly digest to ${outPath}`);

  const email = opts?.email ? await emailDigest(config, markdown, label, say) : null;
  return { written: true, path: outPath, week: label, personalities: targets.length, email };
}

export async function runDigest(argv: string[]): Promise<void> {
  const sub = argv[0];
  const json = argv.includes('--json');
  if (sub !== 'run') {
    if (json) writeJsonError('INVALID_INPUT', 'Usage: ethos digest run [--email] [--json]');
    console.log('Usage: ethos digest run [--email] [--json]');
    return;
  }
  const wantEmail = argv.includes('--email');

  try {
    const { readConfig } = await import('@ethosagent/config');
    const { getStorage, getSecretsResolver } = await import('../wiring');

    const config = await readConfig(getStorage(), await getSecretsResolver());
    if (!config) {
      if (json) writeJsonError('CONFIG_MISSING', 'Run `ethos setup` first.');
      console.error('Run `ethos setup` first.');
      process.exit(1);
    }

    const outcome = await runDigestOnce(config, { email: wantEmail, json });
    if (json) writeJson({ ok: true, ...outcome });
  } catch (err) {
    // Unexpected failures reach index.ts's top-level catch, which emits the one JSON doc.
    if (json) throw err;
    surface(err);
  }
}

// Best-effort email delivery. Fully guarded: a missing email platform config
// or empty recipient list prints a notice and skips; a send failure logs and
// does not crash. Plain-markdown body — themed HTML styling is a deferred
// follow-up (see Phase 3e notes).
async function emailDigest(
  config: import('@ethosagent/config').EthosConfig,
  markdown: string,
  label: string,
  say: (line: string) => void,
): Promise<DigestEmailOutcome> {
  const user = config.emailUser;
  const password = config.emailPassword;
  const smtpHost = config.emailSmtpHost;
  const recipients = config.weeklyDigest?.recipients ?? [];

  if (!user || !password || !smtpHost) {
    say(
      '--email: no email platform configured (emailSmtpHost/emailUser/emailPassword); skipping send.',
    );
    return { skipped: 'no email platform configured', sent: [], failed: [] };
  }
  if (recipients.length === 0) {
    say('--email: weeklyDigest.recipients is empty; skipping send.');
    return { skipped: 'weeklyDigest.recipients is empty', sent: [], failed: [] };
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
  const nodemailerImport: unknown = await import('nodemailer');
  const nodemailer = nodemailerImport as NodemailerModule;
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: config.emailSmtpPort ?? 587,
    secure: config.emailSmtpPort === 465,
    auth: { user, pass: password },
  });

  const sent: string[] = [];
  const failed: string[] = [];
  for (const to of recipients) {
    try {
      await transporter.sendMail({
        from: user,
        to,
        subject: `Ethos weekly digest — ${label}`,
        text: markdown,
      });
      say(`--email: sent digest to ${to}`);
      sent.push(to);
    } catch (err) {
      failed.push(to);
      console.error(
        `--email: failed to send to ${to}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { skipped: null, sent, failed };
}
