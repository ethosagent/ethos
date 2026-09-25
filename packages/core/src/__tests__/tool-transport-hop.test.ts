// Transport hop (architecture plan F02) — proves the ToolContext the AgentLoop
// builds reaches a tool intact through DefaultToolRegistry → LocalToolTransport.
//
// The transport rebuilds the tool ctx, and every ToolContext field comes from
// exactly one channel:
//   wire    — rides the serializable ToolExecuteRequest, so a remote transport
//             sees it too
//   live    — callbacks and live handles; ride only the local side-channel,
//             never the request
//   derived — resolved by the transport from the tool's DECLARED capabilities;
//             a caller-supplied value is deliberately not forwarded, or a tool
//             could reach a handle it never declared
//   budget  — recomputed per call (the per-call split, capped by maxResultChars)
//
// `PARTITION` is typed `Record<keyof ToolContext, Channel>`, so a new
// ToolContext field fails typecheck here until it is classified — and the
// parity tests below then fail until both projections forward it.
//
// It regressed as `rootSessionKey`: dropped by both projections, so a nested
// background turn (root `cli:root`, child `background:child`, job `job-child`)
// handed its tools no root, and delegation counted against the child session.

import type {
  Attachment,
  AttachmentCache,
  KeyValueStore,
  ScopedAttachments,
  ScopedFetch,
  ScopedFs,
  ScopedProcess,
  ScopedSecretsResolver,
  ScriptToolsApi,
  SimpleCompletion,
  Storage,
  Tool,
  ToolContext,
  ToolExecuteRequest,
  ToolInvocationFilter,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { LocalToolTransport } from '../local-tool-transport';
import { DefaultToolRegistry } from '../tool-registry';

type Channel = 'wire' | 'live' | 'derived' | 'budget';

const PARTITION: Record<keyof ToolContext, Channel> = {
  sessionId: 'wire',
  sessionKey: 'wire',
  platform: 'wire',
  workingDir: 'wire',
  agentId: 'wire',
  rootSessionKey: 'wire',
  jobId: 'wire',
  reviewOfJobId: 'wire',
  toolsetNarrowing: 'wire',
  origin: 'wire',
  toolCallId: 'wire',
  personalityId: 'wire',
  memoryScopeId: 'wire',
  userScopeId: 'wire',
  teamId: 'wire',
  currentTurn: 'wire',
  messageCount: 'wire',
  networkPolicy: 'wire',
  dryRun: 'wire',
  abortSignal: 'live',
  emit: 'live',
  storage: 'live',
  readMtimes: 'live',
  a2aDelegation: 'live',
  scriptTools: 'live',
  llm: 'live',
  getContext: 'live',
  setContext: 'live',
  kvStore: 'derived',
  secretsResolver: 'derived',
  scopedFetch: 'derived',
  scopedFs: 'derived',
  scopedProcess: 'derived',
  attachments: 'derived',
  resultBudgetChars: 'budget',
};

const keysOf = (channel: Channel): Array<keyof ToolContext> =>
  (Object.keys(PARTITION) as Array<keyof ToolContext>).filter((k) => PARTITION[k] === channel);

/** An opaque stand-in for a live or derived handle — compared by identity only. */
const handle = <T>(label: string): T => ({ handle: label }) as unknown as T;

/** Every ToolContext field populated, with fresh live handles on each call. */
function fullCtx(overrides: Partial<ToolContext> = {}): Required<ToolContext> {
  const contextStore = new Map<string, unknown>();
  return {
    sessionId: 'sess-child',
    sessionKey: 'background:child',
    platform: 'telegram',
    workingDir: '/work/child',
    agentId: 'depth:1',
    rootSessionKey: 'cli:root',
    jobId: 'job-child',
    reviewOfJobId: 'job-reviewed',
    toolsetNarrowing: { narrow: ['probe'], exclude: ['terminal'] },
    origin: 'telegram:chat-9',
    toolCallId: 'call-1',
    personalityId: 'researcher',
    memoryScopeId: 'personality:researcher',
    userScopeId: 'user:u1',
    teamId: 'team-1',
    currentTurn: 3,
    messageCount: 7,
    networkPolicy: { allow: ['example.com'], deny: ['bad.example.com'] },
    dryRun: false,
    abortSignal: new AbortController().signal,
    emit: () => {},
    storage: handle<Storage>('storage'),
    readMtimes: new Map(),
    a2aDelegation: { traceId: 'trace-1', depth: 1, reserveOutbound: () => true },
    scriptTools: handle<ScriptToolsApi>('scriptTools'),
    llm: handle<SimpleCompletion>('llm'),
    getContext: <T>(key: string) => contextStore.get(key) as T | undefined,
    setContext: <T>(key: string, value: T) => {
      contextStore.set(key, value);
    },
    kvStore: handle<KeyValueStore>('kvStore'),
    secretsResolver: handle<ScopedSecretsResolver>('secretsResolver'),
    scopedFetch: handle<ScopedFetch>('scopedFetch'),
    scopedFs: handle<ScopedFs>('scopedFs'),
    scopedProcess: handle<ScopedProcess>('scopedProcess'),
    attachments: handle<ScopedAttachments>('attachments'),
    resultBudgetChars: 10_000,
    ...overrides,
  };
}

function probeTool(seen: ToolContext[], capabilities: Tool['capabilities'] = {}): Tool {
  return {
    name: 'probe',
    description: 'Records the ctx the transport handed it.',
    schema: { type: 'object' },
    capabilities,
    execute: async (_args, ctx) => {
      seen.push(ctx);
      return { ok: true, value: 'seen' };
    },
  };
}

describe('ToolContext transport hop — DefaultToolRegistry → LocalToolTransport', () => {
  it('a nested background turn keeps its root (the review probe)', async () => {
    const seen: ToolContext[] = [];
    const reg = new DefaultToolRegistry();
    reg.register(probeTool(seen));

    await reg.executeParallel([{ toolCallId: 'call-1', name: 'probe', args: {} }], fullCtx());

    expect(seen[0]?.sessionKey).toBe('background:child');
    expect(seen[0]?.jobId).toBe('job-child');
    expect(seen[0]?.rootSessionKey).toBe('cli:root');
  });

  it('forwards every wire field and every live handle; derived handles are re-resolved, never forwarded', async () => {
    const seen: ToolContext[] = [];
    const reg = new DefaultToolRegistry();
    reg.register(probeTool(seen));
    const caller = fullCtx();

    await reg.executeParallel([{ toolCallId: caller.toolCallId, name: 'probe', args: {} }], caller);

    const got = seen[0];
    expect(got).toBeDefined();
    for (const key of keysOf('wire')) expect(got?.[key], key).toEqual(caller[key]);
    for (const key of keysOf('live')) expect(got?.[key], key).toBe(caller[key]);
    // `capabilities: {}` and no backends → the transport resolves nothing, and
    // whatever the caller carried must not leak through.
    for (const key of keysOf('derived')) expect(got?.[key], key).toBeUndefined();
    expect(got?.resultBudgetChars).toBe(caller.resultBudgetChars);
  });

  it('the context getter/setter reach the tool bound to the caller store', async () => {
    const reg = new DefaultToolRegistry();
    reg.register({
      name: 'ctx_roundtrip',
      description: 'Writes then reads through ctx.setContext/getContext.',
      schema: { type: 'object' },
      capabilities: {},
      execute: async (_args, ctx) => {
        ctx.setContext?.('written-by-tool', 'yes');
        return { ok: true, value: String(ctx.getContext?.('seeded-by-caller')) };
      },
    });
    const caller = fullCtx();
    caller.setContext('seeded-by-caller', 'hello');

    const [r] = await reg.executeParallel(
      [{ toolCallId: 'c1', name: 'ctx_roundtrip', args: {} }],
      caller,
    );

    expect(r?.result).toEqual({ ok: true, value: 'hello' });
    expect(caller.getContext('written-by-tool')).toBe('yes');
  });
});

describe('ToolContext transport hop — explicit LocalToolTransport request', () => {
  const request: Required<ToolExecuteRequest> = {
    toolCallId: 'call-x',
    name: 'probe',
    args: {},
    sessionId: 'sess-child',
    sessionKey: 'background:child',
    platform: 'cli',
    workingDir: '/work/child',
    personalityId: 'researcher',
    teamId: 'team-1',
    agentId: 'depth:1',
    rootSessionKey: 'cli:root',
    jobId: 'job-child',
    reviewOfJobId: 'job-reviewed',
    toolsetNarrowing: { narrow: ['probe'], exclude: ['terminal'] },
    origin: 'telegram:chat-9',
    memoryScopeId: 'personality:researcher',
    userScopeId: 'user:u1',
    currentTurn: 2,
    messageCount: 5,
    resultBudgetChars: 4_000,
    networkPolicy: { allow: ['example.com'] },
    dryRun: false,
  };

  it('every wire field on the request lands on the reconstructed ctx', async () => {
    const seen: ToolContext[] = [];
    const tool = probeTool(seen);
    const transport = new LocalToolTransport((n) => (n === tool.name ? tool : undefined));

    await transport.execute(request, new AbortController().signal);

    const got = seen[0];
    expect(got?.rootSessionKey).toBe('cli:root');
    const carried = (Object.keys(request) as Array<keyof ToolExecuteRequest>).filter(
      (k): k is Exclude<keyof ToolExecuteRequest, 'name' | 'args'> => k !== 'name' && k !== 'args',
    );
    for (const key of carried) expect(got?.[key], key).toEqual(request[key]);
  });

  it('the request can carry every wire field (a remote transport sees the same identity)', () => {
    const requestKeys = Object.keys(request);
    for (const key of keysOf('wire')) expect(requestKeys, key).toContain(key);
  });

  it('executeWithLive supplies the live handles; plain execute supplies none', async () => {
    const seen: ToolContext[] = [];
    const tool = probeTool(seen);
    const live = fullCtx();
    const transport = new LocalToolTransport((n) => (n === tool.name ? tool : undefined));

    await transport.executeWithLive(request, new AbortController().signal, live);
    await transport.execute(request, new AbortController().signal);

    const [withLive, withoutLive] = seen;
    for (const key of keysOf('live')) {
      if (key === 'abortSignal') continue; // the transport's `signal` argument, not live state
      expect(withLive?.[key], key).toBe(live[key]);
      // `emit` falls back to a no-op rather than undefined — every tool may call it.
      if (key === 'emit') expect(typeof withoutLive?.emit, key).toBe('function');
      else expect(withoutLive?.[key], key).toBeUndefined();
    }
  });
});

describe('ToolContext transport hop — interleaved batches', () => {
  it("each batch's tools see that batch's live handles, not the latest batch's", async () => {
    const seen: ToolContext[] = [];
    const reg = new DefaultToolRegistry();
    reg.register(probeTool(seen));

    // Batch A parks in an async `before` filter; batch B runs start to finish
    // in the gap. A registry-level "latest live ctx" slot would hand A's tool
    // B's handles once A resumes.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const filters: ToolInvocationFilter[] = [
      {
        toolName: 'probe',
        before: async (_args, ctx) => {
          if (ctx.sessionId === 'sess-a') await gate;
          return null;
        },
      },
    ];
    const a = fullCtx({ sessionId: 'sess-a' });
    const b = fullCtx({ sessionId: 'sess-b' });

    const batchA = reg.executeParallel(
      [{ toolCallId: 'a1', name: 'probe', args: {} }],
      a,
      undefined,
      undefined,
      undefined,
      filters,
    );
    await reg.executeParallel(
      [{ toolCallId: 'b1', name: 'probe', args: {} }],
      b,
      undefined,
      undefined,
      undefined,
      filters,
    );
    release();
    await batchA;

    const gotA = seen.find((c) => c.toolCallId === 'a1');
    const gotB = seen.find((c) => c.toolCallId === 'b1');
    for (const key of keysOf('live')) {
      expect(gotA?.[key], `batch A ${key}`).toBe(a[key]);
      expect(gotB?.[key], `batch B ${key}`).toBe(b[key]);
    }
  });

  it("each batch's capability resolution sees that batch's turn attachments", async () => {
    const seen: ToolContext[] = [];
    const cache: AttachmentCache = {
      write: async () => '',
      clear: async () => {},
      pruneOlderThan: async () => ({ removedCount: 0 }),
      resolveLocalPath: (url) => url.replace('file://', ''),
    };
    const reg = new DefaultToolRegistry({ attachmentCache: cache });
    reg.register(probeTool(seen, { attachments: { kinds: '*' } }));

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const filters: ToolInvocationFilter[] = [
      {
        toolName: 'probe',
        before: async (_args, ctx) => {
          if (ctx.sessionId === 'sess-a') await gate;
          return null;
        },
      },
    ];
    const attachment = (ref: string): Attachment => ({
      type: 'file',
      ref,
      url: `https://example.com/${ref}`,
      mimeType: 'text/plain',
    });
    const attA = [attachment('a-doc')];
    const attB = [attachment('b-doc')];

    const batchA = reg.executeParallel(
      [{ toolCallId: 'a1', name: 'probe', args: {} }],
      fullCtx({ sessionId: 'sess-a' }),
      undefined,
      undefined,
      attA,
      filters,
    );
    await reg.executeParallel(
      [{ toolCallId: 'b1', name: 'probe', args: {} }],
      fullCtx({ sessionId: 'sess-b' }),
      undefined,
      undefined,
      attB,
      filters,
    );
    release();
    await batchA;

    expect(seen.find((c) => c.toolCallId === 'a1')?.attachments?.list()).toEqual(attA);
    expect(seen.find((c) => c.toolCallId === 'b1')?.attachments?.list()).toEqual(attB);
  });
});
