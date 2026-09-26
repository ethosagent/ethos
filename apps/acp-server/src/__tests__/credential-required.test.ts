// openclaw-9.5 item 1 — ACP has no masked input. A turn refused pre-turn for a
// missing plugin credential answers with the one-line instruction naming the
// `ethos plugin credentials` command, on both the blocking (HTTP) and the
// streaming (stdio) prompt paths, and every run opts in to the check.

import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import type { AgentEvent } from '@ethosagent/core';
import type { SessionStore } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpServer, type AgentRunner } from '../index';

const CMD = 'ethos plugin credentials weather --set API_KEY';

function refusingRunner() {
  const seen: Array<Record<string, unknown> | undefined> = [];
  const runner: AgentRunner = {
    run: async function* (_text, opts) {
      seen.push(opts as Record<string, unknown> | undefined);
      const events: AgentEvent[] = [
        {
          type: 'credential_required',
          pluginId: 'weather',
          credentialKey: 'API_KEY',
          kind: 'api_key',
          label: 'Weather API key',
          sessionKey: 'acp:s1',
          pendingUserMessage: 'forecast?',
        },
        { type: 'done', text: '', turnCount: 0 },
      ];
      for (const e of events) yield e;
    },
  };
  return { runner, seen };
}

describe('ACP credential_required', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('blocking prompt: answers with the instruction and opts in', async () => {
    const r = refusingRunner();
    const server = new AcpServer({ runner: r.runner, session: {} as SessionStore, authToken: 't' });
    const http = server.startHttp(0);
    await new Promise<void>((resolve) => http.on('listening', () => resolve()));
    close = () => new Promise<void>((resolve) => http.close(() => resolve()));
    const { port } = http.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'prompt',
        params: { sessionKey: 'acp:s1', text: 'forecast?' },
      }),
    });
    const body = (await res.json()) as { result?: { text: string; turnCount: number } };
    expect(body.result?.text).toContain(CMD);
    expect(body.result?.turnCount).toBe(0);
    expect(r.seen[0]).toMatchObject({ credentialPrompt: true });
  });

  it('streaming prompt: the result carries the instruction and the turn ends', async () => {
    const r = refusingRunner();
    const input = new PassThrough();
    const output = new PassThrough();
    new AcpServer({ runner: r.runner, session: {} as SessionStore, input, output }).start();
    const messages: Array<Record<string, unknown>> = [];
    let buf = '';
    output.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
    });
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'prompt', params: { sessionKey: 'sk', text: 'forecast?' } })}\n`,
    );
    await vi.waitFor(() => expect(messages.find((m) => m.id === 7)).toBeDefined());
    const result = messages.find((m) => m.id === 7) as { result?: { text: string } };
    expect(result.result?.text).toContain(CMD);
    expect(r.seen[0]).toMatchObject({ credentialPrompt: true });
  });
});
