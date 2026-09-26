// Plan openclaw-9.5-adoption item 2 — the inbound spool against a REAL
// `kill -9`. Every other spool test simulates a crash by abandoning an
// in-process Gateway and constructing a second one on the same store; none of
// them proves that what is on disk at the instant the kernel ends the process
// is enough for the next process to do the right thing. This one spawns the
// real `ethos gateway start`, SIGKILLs it mid-turn, starts it again on the same
// state dir, and reads what the user was sent.
//
// The outside world is two local stand-ins, both written by this file:
//
//   - a fake channel PLUGIN (loaded from `<state>/plugins/fakechan` like any
//     operator's plugin): inbound is an HTTP POST to it, outbound is a JSON line
//     appended to a file;
//   - a mock OpenAI-compatible LLM, served from THIS process so its state (how
//     many times each step was reached) outlives the gateway restarts.
//
// HOME and ETHOS_STATE_DIR both point into a fresh temp dir, so the real
// `~/.ethos` is never read or written. Every child is killed by the pid this
// file spawned, in `afterEach` too.
//
// Integration tier (`pnpm test:integration`, `vitest.integration.config.ts`):
// three real gateway boots under tsx take tens of seconds, so it stays out of
// the default suite, like the real-socket suites beside it.

import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo, createConnection, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const CLI = join(REPO_ROOT, 'apps', 'ethos', 'src', 'index.ts');
const INTERRUPTED = 'interrupted after actions had started';

const FAKECHAN_PACKAGE = {
  name: 'fakechan',
  version: '1.0.0',
  private: true,
  type: 'module',
  main: './index.js',
  ethos: { type: 'plugin', pluginContractMajor: 4, pluginApi: '1.0.0' },
};

const FAKECHAN_INDEX = `import { appendFileSync } from 'node:fs';
import http from 'node:http';

export function activate(api) {
  api.registerPlatformAdapter('chan', () => {
    let server;
    return {
      id: 'fakechan/chan',
      displayName: 'Fake channel',
      canSendTyping: false,
      canEditMessage: false,
      canReact: false,
      canSendFiles: false,
      maxMessageLength: 100000,
      async startWithContext(ctx) {
        server = http.createServer((req, res) => {
          let raw = '';
          req.on('data', (d) => (raw += d));
          req.on('end', () => {
            const m = JSON.parse(raw);
            ctx.onMessage({
              platform: 'fakechan/chan', chatId: m.chatId, userId: 'u1', text: m.text,
              isDm: true, isGroupMention: false, messageId: m.messageId, raw: {},
            }).catch(() => {});
            res.end('ok');
          });
        });
        server.listen(Number(process.env.FAKECHAN_PORT), '127.0.0.1');
      },
      async start() {},
      async stop() { server?.close(); },
      async send(chatId, msg) {
        appendFileSync(process.env.FAKECHAN_OUT, JSON.stringify({ chatId, text: msg.text }) + '\\n');
        return { ok: true, messageId: String(Date.now()) };
      },
      onMessage() {},
      async health() { return { ok: true }; },
    };
  });
}
`;

// ---------------------------------------------------------------------------
// Mock LLM
// ---------------------------------------------------------------------------

interface MockLlm {
  server: Server;
  port: number;
  /** How many times each step was reached, across every gateway process. */
  steps: Map<string, number>;
  /** Requests the mock is deliberately never answering. */
  hung: Set<ServerResponse>;
}

function textOf(m: { content?: unknown } | undefined): string {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map((p: { text?: string }) => p.text ?? '').join('');
  }
  return '';
}

type Decision = { step: string } & ({ hang: true } | { text: string } | { tool: string });

function decide(llm: MockLlm, body: { messages?: Array<{ role: string; content?: unknown }> }) {
  const bump = (k: string): number => {
    const n = (llm.steps.get(k) ?? 0) + 1;
    llm.steps.set(k, n);
    return n;
  };
  const msgs = body.messages ?? [];
  const last = msgs[msgs.length - 1];
  const user = textOf([...msgs].reverse().find((m) => m.role === 'user'));
  let d: Decision;
  if (user.includes('TOOLQ')) {
    if (last?.role === 'tool') {
      d =
        (llm.steps.get('toolq-follow') ?? 0) === 0
          ? { hang: true, step: 'toolq-follow' }
          : { text: 'TOOLQ finished.', step: 'toolq-answer' };
    } else {
      d = { tool: 'memory_read', step: 'toolq-tool-call' };
    }
  } else if (user.includes('SLOWQ')) {
    d =
      (llm.steps.get('slowq') ?? 0) === 0
        ? { hang: true, step: 'slowq' }
        : { text: 'answer to SLOWQ', step: 'slowq-answer' };
  } else {
    d = { text: 'echo', step: 'echo' };
  }
  bump(d.step);
  return d;
}

function sse(model: string, d: Decision): string {
  const base = { id: 'c1', object: 'chat.completion.chunk', created: 0, model };
  const chunks: unknown[] = [];
  if ('tool' in d) {
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${Date.now()}`,
                type: 'function',
                function: { name: d.tool, arguments: JSON.stringify({ store: 'memory' }) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else if ('text' in d) {
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: d.text }, finish_reason: null }],
    });
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  chunks.push({
    ...base,
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
}

async function startMockLlm(): Promise<MockLlm> {
  const llm: MockLlm = {
    server: undefined as unknown as Server,
    port: 0,
    steps: new Map(),
    hung: new Set(),
  };
  llm.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'llama3.2', object: 'model' }] }));
        return;
      }
      let body: { model?: string; stream?: boolean; messages?: [] } = {};
      try {
        body = JSON.parse(raw);
      } catch {}
      const d = decide(llm, body);
      if ('hang' in d) {
        llm.hung.add(res);
        return;
      }
      res.setHeader('content-type', 'text/event-stream');
      res.end(sse(body.model ?? 'llama3.2', d));
    });
  });
  await new Promise<void>((resolve) => llm.server.listen(0, '127.0.0.1', resolve));
  llm.port = (llm.server.address() as AddressInfo).port;
  return llm;
}

async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

async function waitFor(pred: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: '127.0.0.1' });
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => resolve(false));
  });
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe('inbound spool — a real SIGKILL of `ethos gateway start`', () => {
  let dir: string;
  let stateDir: string;
  let outFile: string;
  let chanPort: number;
  let llm: MockLlm;
  const children = new Set<ChildProcess>();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-sigkill-spool-'));
    stateDir = join(dir, 'home', '.ethos');
    outFile = join(dir, 'out.jsonl');
    llm = await startMockLlm();
    chanPort = await freePort();
    const personality = join(stateDir, 'personalities', 'smoker');
    mkdirSync(personality, { recursive: true });
    mkdirSync(join(stateDir, 'plugins', 'fakechan'), { recursive: true });
    writeFileSync(
      join(stateDir, 'plugins', 'fakechan', 'package.json'),
      JSON.stringify(FAKECHAN_PACKAGE),
    );
    writeFileSync(join(stateDir, 'plugins', 'fakechan', 'index.js'), FAKECHAN_INDEX);
    writeFileSync(
      join(stateDir, 'config.yaml'),
      [
        'provider: ollama',
        'model: llama3.2',
        `baseUrl: http://127.0.0.1:${llm.port}/v1`,
        'personality: smoker',
        // Large enough that the ~25k-token system prompt (skills, tool
        // schemas) leaves the user's message in the request.
        'contextWindow: 200000',
        // One configured bot, so the gateway runs a bot loop rather than
        // idling: the fake channel's messages carry no botKey and route to
        // the sole bot. The token is fake — the Telegram adapter's `getMe`
        // fails and its polling stops; nothing else depends on it.
        `telegram.bots.0.token: "\${secrets:telegram_token}"`,
        'telegram.bots.0.bind.type: personality',
        'telegram.bots.0.bind.name: smoker',
        'channel_filter.telegram.ownerUserId: "424242"',
        '',
      ].join('\n'),
    );
    // The secrets store is one file per ref under `<state>/secrets/`, mode 0600
    // (what `ethos secrets set` writes); config refuses a plaintext token.
    mkdirSync(join(stateDir, 'secrets'), { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, 'secrets', 'telegram_token'), '123456:SPOOLTESTFAKETOKEN\n', {
      mode: 0o600,
    });
    writeFileSync(join(personality, 'config.yaml'), 'name: Smoker\ndescription: Spool test.\n');
    writeFileSync(join(personality, 'SOUL.md'), 'I answer briefly.\n');
    writeFileSync(join(personality, 'toolset.yaml'), '- memory_read\n');
    writeFileSync(outFile, '');
  });

  afterEach(async () => {
    for (const child of children) child.kill('SIGKILL');
    children.clear();
    for (const res of llm.hung) res.destroy();
    await new Promise<void>((resolve) => llm.server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  async function startGateway(): Promise<ChildProcess> {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'gateway', 'start'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: join(dir, 'home'),
        ETHOS_STATE_DIR: stateDir,
        FAKECHAN_PORT: String(chanPort),
        FAKECHAN_OUT: outFile,
        ETHOS_SKIP_VALIDATION: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    const log = join(dir, `gateway-${child.pid}.log`);
    child.stdout?.on('data', (d) => appendFileSync(log, d));
    child.stderr?.on('data', (d) => appendFileSync(log, d));
    const deadline = Date.now() + 90_000;
    while (!(await portOpen(chanPort))) {
      if (child.exitCode !== null) {
        throw new Error(`gateway exited ${child.exitCode}:\n${readFileSync(log, 'utf8')}`);
      }
      if (Date.now() > deadline) throw new Error('gateway did not open the fake channel');
      await new Promise((r) => setTimeout(r, 200));
    }
    return child;
  }

  async function sigkill(child: ChildProcess): Promise<void> {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;
    children.delete(child);
    // The kernel closed the child's sockets; the mock's hung responses are dead.
    for (const res of llm.hung) res.destroy();
    llm.hung.clear();
  }

  async function send(chatId: string, text: string, messageId: string): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${chanPort}`, {
      method: 'POST',
      body: JSON.stringify({ chatId, text, messageId }),
    });
    await res.text();
  }

  function said(chatId: string, needle: string): number {
    return readFileSync(outFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { chatId: string; text: string })
      .filter((m) => m.chatId === chatId && m.text.includes(needle)).length;
  }

  function spoolRow(messageId: string): { status: string; tool: number } | undefined {
    const db = new Database(join(stateDir, 'inbound-spool.db'), { readonly: true });
    try {
      return db
        .prepare(
          `SELECT status, tool_started_at IS NOT NULL AS tool FROM inbound_spool
           WHERE message_id = ?`,
        )
        .get(messageId) as { status: string; tool: number } | undefined;
    } finally {
      db.close();
    }
  }

  it('replays an unstarted turn exactly once; a tool-started one gets one notice and runs only on retry', async () => {
    // 1. SIGKILL after accept, before completion, no tool started.
    const first = await startGateway();
    await send('chat-a', 'SLOWQ what is the capital', 'a1');
    await waitFor(() => llm.steps.get('slowq') === 1, 'the first SLOWQ request');
    expect(spoolRow('a1')).toMatchObject({ status: 'processing', tool: 0 });
    await sigkill(first);

    const second = await startGateway();
    await waitFor(() => said('chat-a', 'answer to SLOWQ') >= 1, 'the replayed answer');
    // Give a second replay (the boot sweep, a timer tick) the chance to misfire.
    await new Promise((r) => setTimeout(r, 1500));
    expect(said('chat-a', 'answer to SLOWQ')).toBe(1);
    expect(llm.steps.get('slowq-answer')).toBe(1);
    await waitFor(() => spoolRow('a1')?.status === 'done', 'the replayed row to close');

    // 2. SIGKILL after a tool started.
    await send('chat-b', 'TOOLQ settle the invoice', 'b1');
    await waitFor(() => llm.steps.get('toolq-follow') === 1, 'the post-tool request');
    expect(llm.steps.get('toolq-tool-call')).toBe(1);
    expect(spoolRow('b1')).toMatchObject({ status: 'processing', tool: 1 });
    await sigkill(second);

    const third = await startGateway();
    await waitFor(() => said('chat-b', INTERRUPTED) >= 1, 'the interrupted notice');
    await new Promise((r) => setTimeout(r, 1500));
    expect(said('chat-b', INTERRUPTED)).toBe(1);
    // Not re-run: the tool was called once, by the killed process.
    expect(llm.steps.get('toolq-tool-call')).toBe(1);
    expect(spoolRow('b1')?.status).toBe('interrupted');

    // Only the user's `retry` runs it again.
    await send('chat-b', 'retry', 'b2');
    await waitFor(() => said('chat-b', 'TOOLQ finished') >= 1, 'the retried answer');
    expect(llm.steps.get('toolq-tool-call')).toBe(2);
    expect(spoolRow('b1')?.status).toBe('done');

    const exited = new Promise<void>((resolve) => third.once('exit', () => resolve()));
    third.kill('SIGTERM');
    await exited;
    children.delete(third);
  }, 300_000);
});
