// Plan plugin-process-isolation §5.6. Every `ToolContext` key gets a host-hop
// class, typed `Record<keyof ToolContext, ...>` so a new key fails typecheck
// until it is classified (the drift idea of PARTITION in
// packages/core/src/__tests__/tool-transport-hop.test.ts, which is not edited):
//
//   wire        rides the ToolExecuteRequest fields, copied as they are
//   reverse     the host holds a stub; each use is an `ethos/capability.*` (or
//               `ethos/emit`) request served from the call's own live handle
//   host-local  rebuilt inside the host (`abortSignal` from `ethos/cancel`,
//               `scopedProcess` from the declared allowedBinaries)
//   absent      the host sees `undefined`, as behind any non-local transport
//
// `getContext`/`setContext` are `absent`, not reverse as plan §5.6 says: they
// are synchronous and a pipe cannot answer synchronously.

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Attachment, ToolContext, ToolProgressEvent } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { requestFromContext } from '../proxies/request';
import { eventsOf, fixtureDir, type Harness, makeCtx, makeHarness } from './helpers/harness';

type Hop = 'wire' | 'reverse' | 'host-local' | 'absent';

const HOST_HOP: Record<keyof ToolContext, Hop> = {
  sessionId: 'wire',
  sessionKey: 'wire',
  platform: 'wire',
  workingDir: 'wire',
  agentId: 'wire',
  rootSessionKey: 'wire',
  jobId: 'wire',
  reviewOfJobId: 'wire',
  roomAudience: 'wire',
  initiator: 'wire',
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
  resultBudgetChars: 'wire',
  abortSignal: 'host-local',
  scopedProcess: 'host-local',
  emit: 'reverse',
  storage: 'reverse',
  llm: 'reverse',
  kvStore: 'reverse',
  secretsResolver: 'reverse',
  scopedFetch: 'reverse',
  scopedFs: 'reverse',
  attachments: 'reverse',
  readMtimes: 'absent',
  a2aDelegation: 'absent',
  scriptTools: 'absent',
  getContext: 'absent',
  setContext: 'absent',
};

const SLOW = 40_000;
let h: Harness | undefined;
let scratch: string | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

interface Probe {
  present: Record<string, boolean>;
  wire: Record<string, unknown>;
  calls: Record<string, unknown>;
}

async function fullContext(): Promise<{
  ctx: ToolContext;
  emitted: ToolProgressEvent[];
  fetched: Array<{ url: string; init: RequestInit | undefined }>;
}> {
  scratch = await mkdtemp(join(tmpdir(), 'plugin-host-ctx-'));
  const attachmentFile = join(scratch, 'cached.bin');
  await writeFile(attachmentFile, 'attach-bytes');
  const attachment: Attachment = {
    type: 'file',
    ref: 'ref-1',
    url: 'file://x',
    mimeType: 'text/plain',
    filename: 'cached.bin',
  };
  const store = new InMemoryStorage();
  await store.mkdir('/probe');
  await store.write('/probe/file', 'file-content');
  const kv = new Map<string, string>();
  const emitted: ToolProgressEvent[] = [];
  const fetched: Array<{ url: string; init: RequestInit | undefined }> = [];
  const ctx: ToolContext = {
    ...makeCtx(),
    sessionId: 'sess-1',
    sessionKey: 'cli:sess-1',
    platform: 'cli',
    workingDir: '/work',
    agentId: 'depth:1',
    rootSessionKey: 'cli:root',
    jobId: 'job-1',
    reviewOfJobId: 'job-0',
    roomAudience: 'shared',
    initiator: 'user',
    toolsetNarrowing: { narrow: ['x'] },
    origin: 'cli:chat',
    toolCallId: 'call-ctx',
    personalityId: 'researcher',
    memoryScopeId: 'personality:researcher',
    userScopeId: 'user:u1',
    teamId: 'team-1',
    currentTurn: 4,
    messageCount: 9,
    networkPolicy: { allow: ['example.com'] },
    dryRun: false,
    resultBudgetChars: 1234,
    emit: (e) => void emitted.push(e),
    storage: store,
    kvStore: {
      get: async (k) => kv.get(k) ?? null,
      set: async (k, v) => void kv.set(k, v),
      delete: async (k) => void kv.delete(k),
      list: async (prefix) => [...kv.keys()].filter((k) => k.startsWith(prefix)),
    },
    secretsResolver: {
      get: async (ref) => {
        if (ref !== 'plugins/ctxprobe/token') throw new Error('nope');
        return 'tok';
      },
    },
    scopedFetch: {
      fetch: async (url, init) => {
        fetched.push({ url: String(url), init });
        return new Response(`fetched:${String(init?.body)}`, {
          status: 200,
          headers: { 'x-reply': 'yes' },
        });
      },
    },
    scopedFs: {
      read: async (p) => `fs:${p}`,
      readBytes: async () => new Uint8Array(),
      write: async () => undefined,
      exists: async () => true,
      list: async () => [],
      mtime: async () => 1,
      mkdir: async () => undefined,
      listEntries: async () => [],
    },
    llm: { complete: async (prompt, o) => `llm:${prompt}:${o?.maxTokens}` },
    attachments: {
      list: () => [attachment],
      open: async () => ({ path: attachmentFile }),
      openByRef: async () => ({ path: attachmentFile }),
    },
  };
  return { ctx, emitted, fetched };
}

describe('ToolContext host hop (plan §5.6)', () => {
  it(
    'every key behaves as its class says, and each reverse handle round-trips through the call own handle',
    async () => {
      h = await makeHarness();
      const lease = await h.pool.acquire({ id: 'ctxprobe', dir: fixtureDir('ctxprobe') });
      const { ctx, emitted, fetched } = await fullContext();
      const result = await lease.callTool(requestFromContext('ctx_probe', {}, ctx), ctx);
      expect(result.ok ? '' : result.error).toBe('');
      const probe: Probe = JSON.parse(result.ok ? result.value : '{}');

      for (const key of Object.keys(HOST_HOP) as Array<keyof ToolContext>) {
        const expected = HOST_HOP[key] !== 'absent';
        expect(probe.present[key], `${key} (${HOST_HOP[key]})`).toBe(expected);
      }
      expect(probe.wire).toEqual({
        sessionId: 'sess-1',
        personalityId: 'researcher',
        workingDir: '/work',
        currentTurn: 4,
        toolCallId: 'call-ctx',
        origin: 'cli:chat',
        resultBudgetChars: 1234,
      });
      expect(probe.calls).toMatchObject({
        storage: 'file-content',
        kv: 'b',
        secret: 'tok',
        fetch: { status: 200, text: 'fetched:payload', header: 'yes' },
        fs: 'fs:/probe/fs',
        llm: 'llm:prompt:7',
        attachmentList: ['ref-1'],
        attachmentBytes: 'attach-bytes',
      });
      expect(fetched[0]).toMatchObject({
        url: 'https://example.com/x',
        init: { method: 'POST', body: 'payload' },
      });
      expect(emitted).toEqual([
        { type: 'progress', toolName: 'ctx_probe', message: 'working', audience: 'user' },
      ]);
      // scopedProcess is host-local: the child spawned it with the host's own environment.
      expect(String(probe.calls.processHome)).toContain('plugin-hosts');
      // The attachment copy lives under the host's home for the call only.
      expect(String(probe.calls.attachmentPath)).toContain('/home/attachments/');
      expect(await attachmentDirEmpty(h)).toBe(true);
    },
    SLOW,
  );

  it(
    'a tool that declares nothing gets only storage; the derived handles and llm are absent',
    async () => {
      h = await makeHarness();
      const lease = await h.pool.acquire({ id: 'ctxprobe', dir: fixtureDir('ctxprobe') });
      const ctx = makeCtx();
      const result = await lease.callTool(requestFromContext('ctx_bare', {}, ctx), ctx);
      expect(JSON.parse(result.ok ? result.value : '{}')).toEqual({
        kvStore: false,
        secretsResolver: false,
        scopedFetch: false,
        scopedFs: false,
        scopedProcess: false,
        attachments: false,
        llm: false,
        storage: true,
      });
    },
    SLOW,
  );

  it(
    'a capability call on a handle kept after its call returned is refused and recorded',
    async () => {
      h = await makeHarness();
      const lease = await h.pool.acquire({ id: 'ctxprobe', dir: fixtureDir('ctxprobe') });
      const { ctx } = await fullContext();
      expect((await lease.callTool(requestFromContext('ctx_probe', {}, ctx), ctx)).ok).toBe(true);
      const later = makeCtx();
      const kept = await lease.callTool(requestFromContext('ctx_keep', {}, later), later);
      expect(kept).toMatchObject({ ok: true });
      expect(kept.ok ? kept.value : '').toMatch(/^refused:.*PLUGIN_HOST_HANDLE_REVOKED/);
      expect(eventsOf(h, 'plugin_host.denied').some((e) => e.payload.kind === 'handle')).toBe(true);
      expect(h.pool.entry('ctxprobe')?.handles.size).toBe(0);
    },
    SLOW,
  );
});

/** The per-call copy is removed once the call's handle is revoked (asynchronously). */
async function attachmentDirEmpty(harness: Harness): Promise<boolean> {
  const dir = join(harness.dataDir, 'plugin-hosts', 'ctxprobe', 'home', 'attachments');
  for (let i = 0; i < 50; i++) {
    const now = await readdir(dir).catch(() => []);
    if (now.length === 0) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}
