/** createNodeProxyTool / createNodeListTool (plan laptop-tool-node T5). */
import type { Tool, ToolContext, ToolProgressEvent } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { NODE_RESULT_CAP_CHARS } from '../caps';
import { NodeHub } from '../node-hub';
import { createNodeListTool, createNodeProxyTool, nodeCallTimeoutMs } from '../node-proxy';
import { fakeConn, makeHello } from './fixtures';

const base: Tool = {
  name: 'read_file',
  description: 'Reads a file.',
  schema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  capabilities: { network: { allowedHosts: [] } },
  isAvailable: () => true,
  maxResultChars: 1_000_000,
  execute: async () => ({ ok: true, value: 'LOCAL' }),
};

function setup() {
  const conn = fakeConn();
  const hub = new NodeHub({ randomId: () => 'c1', now: () => 1_700_000_000_000 });
  const session = hub.attach('k1', makeHello({ clock: 1_700_000_000_000 }), conn);
  return { hub, sent: conn.sent, session };
}

function ctx(over: Partial<ToolContext> = {}, events: ToolProgressEvent[] = []): ToolContext {
  return {
    toolCallId: 'tc1',
    sessionId: 's',
    sessionKey: 'k',
    platform: 'cli',
    workingDir: '/srv',
    personalityId: 'coder',
    roomAudience: 'private',
    initiator: 'user',
    currentTurn: 2,
    messageCount: 4,
    resultBudgetChars: 5000,
    abortSignal: new AbortController().signal,
    emit: (e) => void events.push(e),
    ...over,
  };
}

describe('createNodeProxyTool', () => {
  it('has the documented static shape', () => {
    const { hub } = setup();
    const t = createNodeProxyTool(base, hub);
    expect(t.name).toBe('node_read_file');
    expect(t.toolset).toBe('node');
    expect(t.outputIsUntrusted).toBe(true);
    expect(t.capabilities).toEqual({});
    expect(t.isAvailable).toBeUndefined();
    expect(t.maxResultChars).toBe(NODE_RESULT_CAP_CHARS);
    expect(t.schema.required).toEqual(['path']);
    expect(t.schema.properties).toEqual({
      path: { type: 'string' },
      node: expect.objectContaining({ type: 'string' }),
    });
    expect(t.description).toBe(createNodeProxyTool(base, hub).description);
    expect(t.description).toContain('Reads a file.');
  });

  it('sends the base name without the node arg, carrying ctx fields; downgrades progress', async () => {
    const { hub, sent, session } = setup();
    const events: ToolProgressEvent[] = [];
    const t = createNodeProxyTool(base, hub);
    const p = t.execute({ path: 'a.txt', node: 'lap' }, ctx({}, events));
    const frame = sent[0];
    expect(frame?.kind).toBe('call');
    if (frame?.kind !== 'call') throw new Error('no call frame');
    expect(frame.request.name).toBe('read_file');
    expect(frame.request.args).toEqual({ path: 'a.txt' });
    expect(frame.request).toMatchObject({
      personalityId: 'coder',
      roomAudience: 'private',
      initiator: 'user',
      resultBudgetChars: 5000,
    });
    session.receive({ v: 1, kind: 'progress', callId: 'c1', message: 'half', audience: 'user' });
    expect(events).toEqual([
      { type: 'progress', toolName: 'node_read_file', message: 'half', audience: 'internal' },
    ]);
    session.receive({ v: 1, kind: 'result', callId: 'c1', result: { ok: true, value: 'hi' } });
    await expect(p).resolves.toEqual({ ok: true, value: 'hi' });
  });

  // Pin for plan D13: a shared room is refused server-side before any frame is sent.
  it('drops node-sent cost_usd and caps an oversize error (the node is not trusted)', async () => {
    for (const cost of [-5, 1e9, Number.NaN]) {
      const { hub, session } = setup();
      const p = createNodeProxyTool(base, hub).execute({ path: 'a' }, ctx());
      session.receive({
        v: 1,
        kind: 'result',
        callId: 'c1',
        result: { ok: true, value: 'v', cost_usd: cost },
      });
      const r = await p;
      expect(r).toEqual({ ok: true, value: 'v' });
    }
    const { hub, session } = setup();
    const p = createNodeProxyTool(base, hub).execute({ path: 'a' }, ctx());
    session.receive({
      v: 1,
      kind: 'result',
      callId: 'c1',
      result: {
        ok: false,
        code: 'execution_failed',
        error: 'e'.repeat(1_000_000),
        cause: { a: 1 },
      },
    });
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.length).toBeLessThan(NODE_RESULT_CAP_CHARS + 100);
      expect(r).not.toHaveProperty('cause');
    }
  });

  it('caps re-emitted progress at 4 KB', async () => {
    const { hub, session } = setup();
    const events: ToolProgressEvent[] = [];
    const p = createNodeProxyTool(base, hub).execute({ path: 'a' }, ctx({}, events));
    session.receive({ v: 1, kind: 'progress', callId: 'c1', message: 'm'.repeat(100_000) });
    expect(events[0]?.message.length).toBe(4096);
    session.receive({ v: 1, kind: 'result', callId: 'c1', result: { ok: true, value: 'x' } });
    await p;
  });

  it('refuses a shared room and sends no frame', async () => {
    const { hub, sent } = setup();
    const r = await createNodeProxyTool(base, hub).execute(
      { path: 'a' },
      ctx({ roomAudience: 'shared' }),
    );
    expect(r).toMatchObject({ ok: false, code: 'not_available' });
    expect(sent).toHaveLength(0);
  });

  // Live smoke 2026-11-24: a strict-schema provider (codex) fills every optional property, so an
  // advertised `ref` came back as the path itself and the node refused every read.
  it('does not advertise the attachment ref on node_read_file', () => {
    const { hub } = setup();
    const withRef: Tool = {
      ...base,
      schema: { ...base.schema, properties: { path: { type: 'string' }, ref: { type: 'string' } } },
    };
    const t = createNodeProxyTool(withRef, hub);
    expect(Object.keys(t.schema.properties as object)).toEqual(['path', 'node']);
  });

  it('treats an empty node arg as unset (strict-schema providers send "")', async () => {
    const { hub, sent } = setup();
    const p = createNodeProxyTool(base, hub).execute({ path: 'a.txt', node: '' }, ctx());
    expect(sent[0]?.kind).toBe('call');
    p.catch(() => undefined);
  });

  it('rejects non-record args', async () => {
    const { hub, sent } = setup();
    const r = await createNodeProxyTool(base, hub).execute('nope', ctx());
    expect(r).toMatchObject({ ok: false, code: 'input_invalid' });
    expect(sent).toHaveLength(0);
  });

  it('picks timeouts per tool', () => {
    expect(nodeCallTimeoutMs('read_file', {})).toBe(60_000);
    expect(nodeCallTimeoutMs('search_files', {})).toBe(60_000);
    expect(nodeCallTimeoutMs('write_file', {})).toBe(360_000);
    expect(nodeCallTimeoutMs('patch_file', {})).toBe(360_000);
    expect(nodeCallTimeoutMs('terminal', {})).toBe(330_000);
    expect(nodeCallTimeoutMs('terminal', { timeout_ms: 999_999_999 })).toBe(900_000);
    expect(nodeCallTimeoutMs('terminal', { timeout_ms: -5 })).toBe(300_001);
  });
});

describe('createNodeListTool', () => {
  it('returns hub.list() as JSON', async () => {
    const { hub } = setup();
    const t = createNodeListTool(hub);
    expect(t.name).toBe('node_list');
    expect(t.outputIsUntrusted).toBe(true);
    expect(t.schema).toEqual({ type: 'object', properties: {} });
    expect(t.description).toBe(createNodeListTool(hub).description);
    const r = await t.execute({}, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.value)).toEqual(JSON.parse(JSON.stringify(hub.list())));
  });
});
