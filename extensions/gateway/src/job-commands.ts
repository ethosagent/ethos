import {
  formatJobEventLine,
  isActiveJob,
  isJobRef,
  type JobControl,
  type JobRefResolution,
  jobActionAllowed,
  resolveJobRef,
  steerRefusalText,
  stopRefusalText,
  unreadSteerPreview,
} from '@ethosagent/job-runner';
import type {
  BackgroundJob,
  InboundMessage,
  JobSteer,
  JobStore,
  TurnAudience,
} from '@ethosagent/types';

/**
 * Channel commands over a lane's background jobs (plan background-job-steer
 * §5.3 / D10 / D11 / D13): `/background list|steer|stop|tail <ref>` and
 * `/stop <ref>`. Policy (status, runner capability, audience refusal) is owned
 * by `JobControl`; this file owns only the lane SCOPE, the ref syntax and the
 * wording. Every reply is an untracked ack, like the `/background` launch ack.
 */

const LANE_JOB_LIMIT = 50;
const TAIL_MAX_CHARS = 1_500;
const LIST_LABEL_CAP = 40;
const NOTICE_STEER_LINES = 3;
const NOTICE_STEER_CHARS = 120;
const STOP_HINT_MAX_JOBS = 5;

export type JobCommand =
  | { kind: 'list' }
  | { kind: 'steer'; ref: string; text: string }
  | { kind: 'stop'; ref: string }
  | { kind: 'tail'; ref: string };

/**
 * Parse the text after `/background `. `null` means "this is a prompt":
 * a sub-word applies only when the next token is ref-shaped (`list` only when
 * it stands alone), so `/background steer the boat` still launches a job.
 */
export function parseJobCommand(bgText: string): JobCommand | null {
  const trimmed = bgText.trim();
  if (/^list$/i.test(trimmed)) return { kind: 'list' };
  const m = /^(steer|stop|tail)\s+(\S+)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!m) return null;
  const ref = m[2] ?? '';
  if (!isJobRef(ref)) return null;
  const kind = (m[1] ?? '').toLowerCase();
  if (kind === 'steer') return { kind: 'steer', ref, text: (m[3] ?? '').trim() };
  if (kind === 'stop') return { kind: 'stop', ref };
  return { kind: 'tail', ref };
}

export interface JobCommandContext {
  bot: { botKey: string; jobStore?: JobStore; jobControl?: JobControl };
  message: InboundMessage;
  threadId: string | undefined;
  /** The requester's audience, `Gateway.jobAudienceFor(message)`. */
  audience: TurnAudience;
  send(text: string): Promise<void>;
}

const short = (id: string): string => id.slice(0, 8);

/**
 * Jobs started from this exact lane (platform, bot, chat, thread) that the
 * requester's audience may act on (D10, D11). Filtering by audience BEFORE
 * matching means an ambiguity list never names a job the room may not see.
 */
async function laneJobs(ctx: JobCommandContext): Promise<BackgroundJob[]> {
  const store = ctx.bot.jobStore;
  if (!store?.listByOrigin) return [];
  const rows = await store.listByOrigin(
    {
      platform: ctx.message.platform,
      botKey: ctx.bot.botKey,
      chatId: ctx.message.chatId,
      ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
    },
    { limit: LANE_JOB_LIMIT },
  );
  return rows.filter((j) => jobActionAllowed(j, ctx.audience));
}

/** `<8> (running), …` for the lane's active jobs (from `rows` when already fetched); empty when none. */
export async function activeLaneJobSummary(
  ctx: JobCommandContext,
  rows?: readonly BackgroundJob[],
): Promise<string> {
  const active = (rows ?? (await laneJobs(ctx))).filter(isActiveJob);
  if (active.length === 0) return '';
  return active
    .slice(0, STOP_HINT_MAX_JOBS)
    .map((j) => `${short(j.id)} (${j.status})`)
    .join(', ');
}

const money = (usd: number): string => `$${usd.toFixed(2)}`;

function oneLine(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

function noJob(ref: string): string {
  return `no job ${ref} in this chat`;
}

function ambiguous(ref: string, ids: string[]): string {
  return `${ref} matches several jobs in this chat: ${ids.join(', ')} — use more characters`;
}

const ambiguousIn = (ref: string, res: Extract<JobRefResolution, { kind: 'ambiguous' }>): string =>
  ambiguous(ref, res.ids.map(short));

/** Run one parsed `/background list|steer|stop|tail` command. */
export async function runJobCommand(cmd: JobCommand, ctx: JobCommandContext): Promise<void> {
  const control = ctx.bot.jobControl;
  if (!control || !ctx.bot.jobStore) {
    await ctx.send('✗ Job control is not available for this bot.');
    return;
  }
  if (cmd.kind === 'list') {
    const active = (await laneJobs(ctx)).filter(isActiveJob);
    if (active.length === 0) {
      await ctx.send('no background jobs running in this chat');
      return;
    }
    const lines = active.map((j) => {
      const label = oneLine(j.label ?? j.prompt, LIST_LABEL_CAP);
      return `${short(j.id)} · ${j.status} · ${label} · ${money(j.spendUsd)}`;
    });
    await ctx.send(`background jobs in this chat:\n${lines.join('\n')}`);
    return;
  }
  if (cmd.kind === 'steer' && cmd.text === '') {
    await ctx.send('✗ Usage: /background steer <id> <text>');
    return;
  }
  const res = resolveJobRef(await laneJobs(ctx), cmd.ref);
  if (res.kind === 'none') {
    await ctx.send(noJob(cmd.ref));
    return;
  }
  if (res.kind === 'ambiguous') {
    await ctx.send(ambiguousIn(cmd.ref, res));
    return;
  }
  const { job } = res;
  const id = short(job.id);
  if (cmd.kind === 'steer') {
    const out = await control.steer(job, {
      text: cmd.text,
      source: 'gateway',
      requesterAudience: ctx.audience,
      ...(ctx.message.userId ? { requesterUserId: ctx.message.userId } : {}),
    });
    await ctx.send(
      out.ok
        ? `↩ noted for job ${id} — it reads this at its next step.`
        : out.reason === 'not_found'
          ? noJob(cmd.ref)
          : steerRefusalText(job, out),
    );
    return;
  }
  if (cmd.kind === 'stop') {
    await ctx.send(await stopJob(job, cmd.ref, control, ctx));
    return;
  }
  const tail = await control.tail(job, { requesterAudience: ctx.audience, audience: 'channel' });
  if (!tail.ok) {
    await ctx.send(noJob(cmd.ref));
    return;
  }
  const row = (await ctx.bot.jobStore.get(job.id)) ?? job;
  const header = `job ${id} · ${row.status} · ${money(row.spendUsd)}`;
  const lines = tail.events.map(formatJobEventLine);
  // Newest lines win: drop from the oldest end until the whole reply fits.
  while (lines.length > 1 && header.length + 1 + lines.join('\n').length > TAIL_MAX_CHARS) {
    lines.shift();
  }
  const body = lines.length === 0 ? '(no activity yet)' : lines.join('\n');
  await ctx.send(`${header}\n${body}`.slice(0, TAIL_MAX_CHARS));
}

/** The reply for a stop of one resolved job (`/background stop` and `/stop <ref>`). */
async function stopJob(
  job: BackgroundJob,
  ref: string,
  control: JobControl,
  ctx: JobCommandContext,
): Promise<string> {
  const out = await control.stop(job, { requesterAudience: ctx.audience });
  if (out.ok) return `✓ Stopping job ${short(job.id)}.`;
  return out.reason === 'not_found' ? noJob(ref) : stopRefusalText(job, out);
}

/**
 * `/stop <ref>`. `reply` is set when the ref named a job in this lane (or was
 * ambiguous); `null` means it matched nothing, so the caller falls back to the
 * plain lane stop and reuses `rows` (the lane's jobs, already fetched) for the
 * "background: …" hint. `rows` is absent when job control is unavailable.
 */
export async function stopJobByRef(
  ctx: JobCommandContext,
  ref: string,
): Promise<{ reply: string | null; rows?: BackgroundJob[] }> {
  const control = ctx.bot.jobControl;
  if (!control || !ctx.bot.jobStore?.listByOrigin) return { reply: null };
  const rows = await laneJobs(ctx);
  const res = resolveJobRef(rows, ref);
  if (res.kind === 'none') return { reply: null, rows };
  if (res.kind === 'ambiguous') return { reply: ambiguousIn(ref, res) };
  return { reply: await stopJob(res.job, ref, control, ctx) };
}

/**
 * The completion-notice suffix for steers the job never read (D8): at most 3
 * lines of 120 chars plus a count. The user's own words, so not wrapped as
 * untrusted. Empty string when there are none.
 */
export function unreadSteerSuffix(unread: JobSteer[]): string {
  if (unread.length === 0) return '';
  const { shown, more } = unreadSteerPreview(unread, {
    lines: NOTICE_STEER_LINES,
    chars: NOTICE_STEER_CHARS,
  });
  const quoted = shown.map((t) => `"${t}"`);
  const noun = unread.length === 1 ? 'message' : 'messages';
  return `\n(${unread.length} ${noun} arrived after it stopped reading:\n${quoted.join('\n')}${more > 0 ? `\n+${more} more` : ''})`;
}
