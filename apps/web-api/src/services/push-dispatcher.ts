import { randomUUID } from 'node:crypto';
import type { PushDeviceRecord, SqlitePushDeviceStore } from '@ethosagent/session-sqlite';
import type { BackgroundJob, PendingClarify } from '@ethosagent/types';
import type { ApprovalRequest, KanbanEvent } from '@ethosagent/web-contracts';
import type { ApprovalsService } from './approvals.service';
import type { KanbanService } from './kanban.service';
import type { PushMessage, PushSendResult, PushTransport } from './push-transport';
import type { SystemEvent, SystemEventBus } from './system-event-bus';

// PushDispatcher (mobile-app plan S5, D11). Five categories reach a phone;
// everything else stays silent in Activity:
//
//   approvals      ApprovalsService onPending      → collapseId = approvalId,
//                  (+ onResolved by timeout →        threadId = sessionId,
//                   a REPLACEMENT, same collapseId,  time-sensitive, category
//                   body `auto-denied at HH:MM`,     `approval` (Allow once /
//                   no categoryId)                   Deny actions live in the app)
//   clarify        the web clarify presenter        → no categoryId (D11
//                  (`createWebApi` calls `clarify`)  deviation — see `clarify()` below)
//   cronFailures   SystemEventBus `cron.failed`     → the error in the body
//   teamAttention  kanban `status_changed` →        → the concrete reason in the
//                  blocked | needs_revision (polled) body
//   runFinished    BackgroundExecutor onComplete    → off unless a device opts in
//
// Payload privacy (D11): `data` carries ids, the personality, a deadline and a
// deep link — NEVER tool args. The approval builder takes named fields only, so
// the args object on `ApprovalRequest` has no path into a message; the
// Notification Service Extension fetches the tool text over the bearer key.
// Each device's category booleans decide what it receives; a revoked key's
// devices are filtered by the store's join, not here.

export type PushCategory = keyof PushDeviceRecord['categories'];

/** Mirrors `SYSTEM_DECIDER` in approvals.service.ts (timeout and shutdown). */
const SYSTEM_DECIDER = '__ethos_system__';
const BODY_MAX = 180;
const DEFAULT_KANBAN_POLL_MS = 10_000;

type Notification = Omit<PushMessage, 'to' | 'mutableContent'>;

/** What the `push` RPC namespace reaches (`rpc/push.ts`). `dispatcher` is
 *  absent under `push.transport: none`. */
export interface PushRpcServices {
  devices: Pick<SqlitePushDeviceStore, 'register' | 'unregister' | 'listWithKeys'>;
  dispatcher?: Pick<PushDispatcher, 'test'>;
}

export interface PushDispatcherOptions {
  devices: { listForActiveKeys(apiKeyId?: string): PushDeviceRecord[] };
  transport: PushTransport;
  /** The personality a session runs, for `data.personality` and the deep link. */
  personalityFor: (sessionId: string) => Promise<string | undefined>;
}

export interface PushSources {
  approvals: Pick<ApprovalsService, 'onPending' | 'onResolved'>;
  systemBus: Pick<SystemEventBus, 'onSystem' | 'offSystem'>;
  kanban?: Pick<KanbanService, 'list' | 'getEventsSince' | 'getRecentEvents'>;
  subscribeJobComplete?: (handler: (job: BackgroundJob) => void) => () => void;
  kanbanPollMs?: number;
}

function clip(text: string): string {
  return text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 1)}…` : text;
}

function chatLink(personality: string | undefined): string | null {
  return personality ? `ethos://p/${personality}/chat` : null;
}

/** The approval push — also what `push.test` sends, with a fixture id. */
function approvalNotification(a: {
  approvalId: string;
  sessionId: string;
  toolName: string;
  personality: string | undefined;
  deadline: string | null;
  test?: true;
}): Notification {
  return {
    title: `Ethos · ${a.personality ?? 'agent'}`,
    // The extension replaces this with the fetched tool text; if that fetch
    // fails this is what the lock screen keeps (D11's fail-closed body).
    body: `Wants to run ${a.toolName} · Open to review`,
    categoryId: 'approval',
    collapseId: a.approvalId,
    threadId: a.sessionId,
    interruptionLevel: 'time-sensitive',
    data: {
      category: 'approvals',
      approvalId: a.approvalId,
      personality: a.personality ?? null,
      deadline: a.deadline,
      deepLink: chatLink(a.personality),
      ...(a.test ? { test: true } : {}),
    },
  };
}

export class PushDispatcher {
  /** Approvals pushed and not yet resolved → their title, so a timeout's
   *  replacement keeps it. An approval nobody was notified of gets none. */
  private readonly notified = new Map<string, string>();
  private readonly kanbanCursors = new Map<string, number>();
  private polling = false;

  constructor(private readonly opts: PushDispatcherOptions) {}

  /** Subscribe to every source; returns the stop. */
  start(sources: PushSources): () => void {
    const offs: Array<() => void> = [
      sources.approvals.onPending((sessionId, request, deadline) => {
        void this.approvalPending(sessionId, request, deadline ?? null);
      }),
      sources.approvals.onResolved((sessionId, approvalId, _decision, decidedBy) => {
        void this.approvalResolved(sessionId, approvalId, decidedBy);
      }),
    ];
    const onSystem = (event: SystemEvent): void => {
      if (event.type === 'cron.failed') void this.cronFailed(event);
    };
    sources.systemBus.onSystem(onSystem);
    offs.push(() => sources.systemBus.offSystem(onSystem));
    if (sources.subscribeJobComplete) {
      offs.push(sources.subscribeJobComplete((job) => void this.jobComplete(job)));
    }
    const kanban = sources.kanban;
    if (kanban) {
      const timer = setInterval(
        () => void this.pollKanban(kanban),
        sources.kanbanPollMs ?? DEFAULT_KANBAN_POLL_MS,
      );
      timer.unref?.();
      offs.push(() => clearInterval(timer));
    }
    return () => {
      for (const off of offs) off();
      this.opts.transport.close();
    };
  }

  async approvalPending(
    sessionId: string,
    request: ApprovalRequest,
    deadline: string | null,
  ): Promise<void> {
    const personality = await this.personality(sessionId);
    const n = approvalNotification({
      approvalId: request.approvalId,
      sessionId,
      toolName: request.toolName,
      personality,
      deadline,
    });
    if (await this.send('approvals', n)) this.notified.set(request.approvalId, n.title);
  }

  /** Only a timeout (or shutdown) settle is pushed: a human decision was made
   *  on a surface that already shows it, and the app renders that row itself. */
  async approvalResolved(sessionId: string, approvalId: string, decidedBy: string): Promise<void> {
    const title = this.notified.get(approvalId);
    this.notified.delete(approvalId);
    if (title === undefined || decidedBy !== SYSTEM_DECIDER) return;
    await this.send('approvals', {
      title,
      body: `auto-denied at ${new Date().toTimeString().slice(0, 5)}`,
      collapseId: approvalId,
      threadId: sessionId,
      interruptionLevel: 'active',
      data: { category: 'approvals', approvalId, resolved: 'auto-denied' },
    });
  }

  async clarify(
    sessionId: string,
    req: Pick<PendingClarify, 'requestId' | 'question' | 'options' | 'defaultDeadlineAt'>,
  ): Promise<void> {
    const personality = await this.personality(sessionId);
    await this.send('clarify', {
      title: `Ethos · ${personality ?? 'agent'}`,
      body: clip(req.question),
      // No `categoryId` (D11 deviation, `apps/mobile/src/push/categories.ts`):
      // an option's title would have to be registered before the notification
      // ever arrives, so a button could only ever read "Option N", never the
      // real text, and the minimal payload below never carries that text
      // either. The banner opens the app instead, where the real options are
      // rendered and answered.
      threadId: sessionId,
      interruptionLevel: 'active',
      data: {
        category: 'clarify',
        clarifyId: req.requestId,
        personality: personality ?? null,
        deadline: req.defaultDeadlineAt,
        deepLink: chatLink(personality),
      },
    });
  }

  async cronFailed(event: Extract<SystemEvent, { type: 'cron.failed' }>): Promise<void> {
    await this.send('cronFailures', {
      title: `Ethos · cron · ${event.jobName}`,
      body: clip(`failed · ${event.error}`),
      interruptionLevel: 'active',
      data: { category: 'cronFailures', jobId: event.jobId, deepLink: null },
    });
  }

  /** One polled batch of a board's events, ascending. A blocked run writes
   *  `run_completed` (its summary IS the block reason) just before the
   *  `status_changed`, so the summary is preferred over `data.reason`, which on
   *  that path is at most a breaker code. */
  async kanbanEvents(team: string, events: KanbanEvent[]): Promise<void> {
    const summaries = new Map<string, string>();
    for (const e of events) {
      if (e.kind === 'run_completed' && typeof e.data.summary === 'string') {
        summaries.set(e.taskId, e.data.summary);
      }
      const to = e.data.to;
      if (e.kind !== 'status_changed' || (to !== 'blocked' && to !== 'needs_revision')) continue;
      const reason =
        summaries.get(e.taskId) ??
        (typeof e.data.reason === 'string' && e.data.reason ? e.data.reason : 'no reason recorded');
      await this.send('teamAttention', {
        title: `Ethos · ${team}`,
        body: clip(`${e.taskId} ${to === 'blocked' ? 'blocked' : 'needs revision'} · ${reason}`),
        interruptionLevel: 'active',
        data: {
          category: 'teamAttention',
          taskId: e.taskId,
          deepLink: `ethos://t/${team}/task/${e.taskId}`,
        },
      });
    }
  }

  async jobComplete(job: BackgroundJob): Promise<void> {
    const detail = job.error ?? job.summary;
    await this.send('runFinished', {
      title: `Ethos · ${job.label ?? job.runner ?? 'run'}`,
      body: clip(detail ? `${job.status} · ${detail}` : job.status),
      interruptionLevel: 'active',
      data: {
        category: 'runFinished',
        jobId: job.id,
        personality: job.personalityId ?? null,
        deepLink: chatLink(job.personalityId),
      },
    });
  }

  /** `push.test` — an approval-shaped push (same category, same actions) to one
   *  key's devices, or every device when `apiKeyId` is undefined, whatever
   *  their toggles say. `data.test` marks the fixture id `test-<uuid>`: no
   *  server approval exists for it, so the app resolves it locally (T4). */
  async test(apiKeyId: string | undefined): Promise<PushSendResult> {
    const devices = this.opts.devices.listForActiveKeys(apiKeyId);
    if (devices.length === 0) return { ok: false, error: 'no registered device' };
    const n = approvalNotification({
      approvalId: `test-${randomUUID()}`,
      sessionId: 'push-test',
      toolName: 'bash',
      personality: 'ethos',
      deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
      test: true,
    });
    return this.opts.transport.send(devices.map((d) => toMessage(d, n)));
  }

  private async pollKanban(kanban: NonNullable<PushSources['kanban']>): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      // Nobody wants team pushes: drop the cursors so a later opt-in starts
      // from "now" instead of replaying everything since.
      if (!this.opts.devices.listForActiveKeys().some((d) => d.categories.teamAttention)) {
        this.kanbanCursors.clear();
        return;
      }
      const { teams } = await kanban.list();
      for (const { name } of teams) {
        const cursor = this.kanbanCursors.get(name);
        if (cursor === undefined) {
          // First sight of a board: start at its newest event, never replay history.
          const tail = await kanban.getRecentEvents(name, 1);
          this.kanbanCursors.set(name, tail[tail.length - 1]?.id ?? 0);
          continue;
        }
        const events = await kanban.getEventsSince(name, cursor);
        const last = events[events.length - 1];
        if (!last) continue;
        this.kanbanCursors.set(name, last.id);
        await this.kanbanEvents(name, events);
      }
    } catch {
      // A board that will not open costs this poll only; the next one retries.
    } finally {
      this.polling = false;
    }
  }

  private async personality(sessionId: string): Promise<string | undefined> {
    return this.opts.personalityFor(sessionId).catch(() => undefined);
  }

  /** True when at least one device was sent to. */
  private async send(category: PushCategory, n: Notification): Promise<boolean> {
    const devices = this.opts.devices.listForActiveKeys().filter((d) => d.categories[category]);
    if (devices.length === 0) return false;
    // Fire-and-forget: an event push that fails is dropped, never retried (S5).
    await this.opts.transport.send(devices.map((d) => toMessage(d, n))).catch(() => undefined);
    return true;
  }
}

function toMessage(device: PushDeviceRecord, n: Notification): PushMessage {
  return { to: device.expoPushToken, mutableContent: true, ...n };
}
