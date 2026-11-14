import type { AgentLoop } from '@ethosagent/core';
import { type BackgroundExecutor, createJobControl } from '@ethosagent/job-runner';
import type {
  AddSteerResult,
  BackgroundJob,
  BackgroundJobEvent,
  BackgroundJobEventType,
  CreateBackgroundJobInput,
  InboundMessage,
  JobSteer,
  JobSteerSource,
  JobStore,
  PlatformAdapter,
} from '@ethosagent/types';
import { vi } from 'vitest';
import { Gateway } from '../index';

// ---------------------------------------------------------------------------
// Helpers (same shape as background-wake.test.ts)
// ---------------------------------------------------------------------------

export async function waitUntil(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

export function stubAdapter(): PlatformAdapter {
  return {
    id: 'test',
    displayName: 'Test',
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ ok: true, messageId: '1' }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  };
}

export function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'test',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'hello',
    isDm: true,
    isGroupMention: false,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    raw: {},
    ...overrides,
  };
}

export const ID_A = '3f2a1b9c-aaaa-4aaa-8aaa-000000000001';
export const ID_B = '9d8e7f60-bbbb-4bbb-8bbb-000000000002';

export function makeJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  const id = overrides.id ?? ID_A;
  return {
    id,
    owner: 'proc-1',
    parentSessionKey: 'parent',
    rootSessionKey: 'root',
    childSessionKey: `child:${id.slice(0, 8)}`,
    depth: 1,
    status: 'running',
    prompt: 'crawl the docs',
    spendUsd: 0.5,
    createdAt: Date.now(),
    originPlatform: 'test',
    originBotKey: 'b1',
    originChatId: 'chat-1',
    roomAudience: 'private',
    ...overrides,
  };
}

/** In-memory `JobStore` with the optional steer/tail methods the gateway reaches through `JobControl`. */
export class FakeJobStore implements JobStore {
  jobs = new Map<string, BackgroundJob>();
  steersByJob = new Map<string, JobSteer[]>();
  eventsByJob = new Map<string, BackgroundJobEvent[]>();
  cancelled: string[] = [];
  addSteerCalls: Array<{ jobId: string; text: string; source: JobSteerSource; user?: string }> = [];
  private seq = 0;
  private steerSeq = 0;

  seed(job: BackgroundJob): BackgroundJob {
    this.jobs.set(job.id, job);
    return job;
  }
  seedSteer(jobId: string, text: string, state: JobSteer['state']): void {
    const list = this.steersByJob.get(jobId) ?? [];
    list.push({
      id: ++this.steerSeq,
      jobId,
      text,
      state,
      source: 'gateway',
      createdAt: Date.now(),
    });
    this.steersByJob.set(jobId, list);
  }
  seedEvent(jobId: string, eventType: BackgroundJobEventType, payload: Record<string, unknown>) {
    const list = this.eventsByJob.get(jobId) ?? [];
    list.push({
      id: list.length + 1,
      jobId,
      seq: list.length + 1,
      eventType,
      payload,
      createdAt: Date.now(),
    });
    this.eventsByJob.set(jobId, list);
  }

  async create(input: CreateBackgroundJobInput): Promise<BackgroundJob> {
    return this.seed({
      spendUsd: 0,
      createdAt: Date.now(),
      ...input,
      id: `0000000${++this.seq}-new`,
      status: 'queued',
    } as BackgroundJob);
  }
  async get(id: string) {
    return this.jobs.get(id) ?? null;
  }
  async claimNextQueued() {
    return null;
  }
  async heartbeat() {}
  async updateSpend() {}
  async requestCancel(id: string) {
    this.cancelled.push(id);
  }
  async markBlocked() {}
  async resumeFromBlocked() {}
  async finish() {}
  async listByRoot() {
    return [];
  }
  async countActiveByRoot() {
    return 0;
  }
  async countActiveByPersonality() {
    return 0;
  }
  async countActive() {
    return 0;
  }
  async reclaimStale() {
    return [];
  }
  async expireQueued() {
    return [];
  }
  async listRunningRemote() {
    return [];
  }
  async pruneTerminal() {
    return 0;
  }
  async listUndelivered() {
    return [];
  }
  async claimDelivery(id: string) {
    const job = this.jobs.get(id);
    if (!job || job.deliveredAt !== undefined) return false;
    job.deliveredAt = Date.now();
    return true;
  }
  async releaseDelivery(id: string) {
    const job = this.jobs.get(id);
    if (job) job.deliveredAt = undefined;
  }
  async claimNotice() {
    return true;
  }
  async releaseNotice() {}
  async appendEvent() {}
  async getEvents(jobId: string, opts?: { limit?: number }) {
    const all = this.eventsByJob.get(jobId) ?? [];
    return opts?.limit ? all.slice(-opts.limit) : all;
  }
  async addSteer(
    jobId: string,
    input: { text: string; source: JobSteerSource; requesterUserId?: string },
  ): Promise<AddSteerResult> {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, reason: 'not_found' };
    if (!['queued', 'running', 'blocked'].includes(job.status)) {
      return { ok: false, reason: 'finished', status: job.status };
    }
    this.addSteerCalls.push({
      jobId,
      text: input.text,
      source: input.source,
      ...(input.requesterUserId ? { user: input.requesterUserId } : {}),
    });
    this.seedSteer(jobId, input.text, 'pending');
    const steer = (this.steersByJob.get(jobId) ?? []).at(-1) as JobSteer;
    return { ok: true, steer };
  }
  async listSteers(jobId: string) {
    return this.steersByJob.get(jobId) ?? [];
  }
  /** Exact four-field match, newest first — `threadId` undefined matches only no-thread rows. */
  async listByOrigin(
    origin: { platform: string; botKey: string; chatId: string; threadId?: string },
    opts?: { limit?: number },
  ) {
    const rows = [...this.jobs.values()]
      .filter(
        (j) =>
          j.originPlatform === origin.platform &&
          j.originBotKey === origin.botKey &&
          j.originChatId === origin.chatId &&
          j.originThreadId === origin.threadId,
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    return opts?.limit ? rows.slice(0, opts.limit) : rows;
  }
}

export function fakeExecutor() {
  const handlers: Array<(job: BackgroundJob) => void> = [];
  const exec = {
    owner: 'proc-1',
    nudge: vi.fn(),
    pokeSteer: vi.fn(),
    onComplete: vi.fn((h: (job: BackgroundJob) => void) => {
      handlers.push(h);
      return () => {};
    }),
  };
  return {
    exec,
    executor: exec as unknown as BackgroundExecutor,
    fire: (job: BackgroundJob) => {
      for (const h of handlers) h(job);
    },
  };
}

export function gatedLoop() {
  const gates: Array<() => void> = [];
  const state = { started: 0 };
  const loop = {
    run: vi.fn(async function* () {
      state.started++;
      await new Promise<void>((res) => gates.push(res));
      yield { type: 'text_delta' as const, text: 'reply' };
      yield { type: 'done' as const, text: 'reply', turnCount: 1 };
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  };
  return {
    loop: loop as unknown as AgentLoop,
    state,
    releaseAll: () => {
      while (gates.length) gates.shift()?.();
    },
  };
}

export function setup() {
  const g = gatedLoop();
  const ex = fakeExecutor();
  const adapter = stubAdapter();
  const store = new FakeJobStore();
  const jobControl = createJobControl({ store, executor: ex.exec });
  const gw = new Gateway({
    bots: [
      {
        botKey: 'b1',
        loop: g.loop,
        binding: { type: 'personality', name: 'default' },
        backgroundExecutor: ex.executor,
        jobStore: store,
        jobControl,
      },
    ],
    adapters: new Map([['test', adapter]]),
    clarifySweepIntervalMs: 0,
  });
  const say = async (text: string, overrides: Partial<InboundMessage> = {}) => {
    await gw.handleMessage(makeMessage({ text, ...overrides }), adapter);
    const calls = (adapter.send as ReturnType<typeof vi.fn>).mock.calls;
    return String(calls.at(-1)?.[1]?.text ?? '');
  };
  return { g, ex, adapter, store, gw, say };
}

export const sentTexts = (adapter: PlatformAdapter): string[] =>
  (adapter.send as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[1]?.text)
    .filter((t): t is string => typeof t === 'string');

// ---------------------------------------------------------------------------
