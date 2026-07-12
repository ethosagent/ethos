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
import { buildWeeklyDigest, isoWeekLabel } from '@ethosagent/digest';
import { formatError, toEthosError } from '@ethosagent/types';

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
export async function runDigestOnce(
  config: import('@ethosagent/config').EthosConfig,
  opts?: { email?: boolean },
): Promise<void> {
  const { ethosDir } = await import('@ethosagent/config');
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
    const { readConfig } = await import('@ethosagent/config');
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
  config: import('@ethosagent/config').EthosConfig,
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
