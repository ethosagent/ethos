// Plan keyless-first-run §4.3 (D16/D17): `RunChatOptions.initialMessage` runs
// one turn through the normal path, then the REPL continues.
//
// Driven as a REAL process (like apps/ethos/src/__tests__/chat-piped-exit.test.ts)
// against a fake OpenAI-compatible server, because `runChat` needs the whole
// runtime. A tiny driver script (written outside the repo) imports `runChat`
// and passes `initialMessage`; piped stdin then plays the person typing.

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const dirs: string[] = [];
const procs: ChildProcess[] = [];

afterEach(async () => {
  for (const p of procs.splice(0)) p.kill();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/**
 * The fake OpenAI-compatible model runs as its own process: one stdout line per
 * chat request (`USER <json text>`), the port on the first line.
 */
const FAKE_MODEL = `
import { createServer } from 'node:http';
let n = 0;
const server = createServer((req, res) => {
  if (req.method === 'GET') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'fake' }] }));
    return;
  }
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    let text = '';
    try {
      const msgs = JSON.parse(raw).messages ?? [];
      const user = [...msgs].reverse().find((m) => m.role === 'user');
      text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
    } catch {}
    n += 1;
    console.log('USER ' + JSON.stringify(text));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const c = (delta, finish) => 'data: ' + JSON.stringify({ id: 'c' + n, object: 'chat.completion.chunk', model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\\n\\n';
    res.write(c({ role: 'assistant', content: 'pong-' + n + '-' }, null));
    res.write(c({ content: 'tail-' + n }, null));
    res.write(c({}, 'stop'));
    res.end('data: [DONE]\\n\\n');
  });
});
server.listen(0, '127.0.0.1', () => console.log('PORT ' + server.address().port));
`;

async function startFakeModel(dir: string): Promise<{ port: number; userTexts: string[] }> {
  const script = join(dir, 'fake-model.mjs');
  await writeFile(script, FAKE_MODEL);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  procs.push(child);
  const userTexts: string[] = [];
  let port = 0;
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += String(d);
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.startsWith('PORT ')) port = Number(line.slice(5));
      if (line.startsWith('USER ')) userTexts.push(JSON.parse(line.slice(5)));
      nl = buf.indexOf('\n');
    }
  });
  const start = Date.now();
  while (port === 0) {
    if (Date.now() - start > 10_000) throw new Error('fake model did not start');
    await new Promise((r) => setTimeout(r, 20));
  }
  return { port, userTexts };
}

/** A minimal env, so the child runs as a plain `ethos` process whatever runs the suite. */
function childEnv(dir: string, state: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: join(dir, 'home'),
    ETHOS_STATE_DIR: state,
    NO_COLOR: '1',
  };
}

async function waitFor(get: () => string, needle: string, ms = 60_000): Promise<void> {
  const start = Date.now();
  while (!get().includes(needle)) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${needle}\n${get()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('runChat initialMessage', () => {
  it('initialMessage runs one turn and the REPL continues', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ethos-chat-initial-'));
    dirs.push(dir);
    const model = await startFakeModel(dir);
    const state = join(dir, 'state');
    await mkdir(join(dir, 'home'), { recursive: true });
    await mkdir(state, { recursive: true });
    await writeFile(
      join(state, 'config.yaml'),
      [
        'schemaVersion: 1',
        'provider: ollama',
        'apiKey: local',
        `baseUrl: http://127.0.0.1:${model.port}/v1`,
        'model: fake',
        '',
      ].join('\n'),
    );
    const driver = join(dir, 'driver.mts');
    const src = (p: string) => JSON.stringify(join(ROOT, p));
    await writeFile(
      driver,
      [
        `import { readConfig } from ${src('packages/config/src/index.ts')};`,
        `import { runChat } from ${src('apps/ethos/src/commands/chat.ts')};`,
        `import { getSecretsResolver, getStorage } from ${src('apps/ethos/src/wiring.ts')};`,
        'const config = await readConfig(getStorage(), await getSecretsResolver());',
        "if (!config) throw new Error('no config');",
        "await runChat(config, { initialMessage: 'FIRST TASK: look around' });",
      ].join('\n'),
    );

    const child = spawn(process.execPath, ['--import', 'tsx', driver], {
      cwd: ROOT,
      env: childEnv(dir, state),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve));

    try {
      // Turn 1: the picked task, as an ordinary user message.
      await waitFor(() => stdout, 'pong-1-tail-1');
      expect(model.userTexts[0]).toBe('FIRST TASK: look around');
      await waitFor(() => stdout, '(2 msgs)');
      // The turn drained to exhaustion: the whole streamed answer is on screen
      // and the REPL accepts the next line as a second, separate turn.
      child.stdin.write('second message\n');
      await waitFor(() => stdout, 'pong-2-tail-2');
      expect(model.userTexts[1]).toBe('second message');
      child.stdin.write('/exit\n');
      await exited;
    } catch (err) {
      child.kill();
      throw new Error(
        `${String(err)}\nrequests: ${JSON.stringify(model.userTexts)}\nSTDERR:\n${stderr}`,
      );
    }
    expect(model.userTexts).toHaveLength(2);
  }, 120_000);

  it('the turn drains the iterator to exhaustion: the second line is not queued behind a half-read turn', async () => {
    // The first turn's `done` is reached before the prompt returns; a typed line
    // sent right after the reply therefore starts a fresh turn instead of being
    // routed to the busy handler (`[queued ...]` / `[interrupted ...]`).
    const dir = await mkdtemp(join(tmpdir(), 'ethos-chat-initial-drain-'));
    dirs.push(dir);
    const model = await startFakeModel(dir);
    const state = join(dir, 'state');
    await mkdir(join(dir, 'home'), { recursive: true });
    await mkdir(state, { recursive: true });
    await writeFile(
      join(state, 'config.yaml'),
      `schemaVersion: 1\nprovider: ollama\napiKey: local\nbaseUrl: http://127.0.0.1:${model.port}/v1\nmodel: fake\n`,
    );
    const driver = join(dir, 'driver.mts');
    const src = (p: string) => JSON.stringify(join(ROOT, p));
    await writeFile(
      driver,
      [
        `import { readConfig } from ${src('packages/config/src/index.ts')};`,
        `import { runChat } from ${src('apps/ethos/src/commands/chat.ts')};`,
        `import { getSecretsResolver, getStorage } from ${src('apps/ethos/src/wiring.ts')};`,
        'const config = await readConfig(getStorage(), await getSecretsResolver());',
        "if (!config) throw new Error('no config');",
        "await runChat(config, { initialMessage: 'one' });",
      ].join('\n'),
    );
    const child = spawn(process.execPath, ['--import', 'tsx', driver], {
      cwd: ROOT,
      env: childEnv(dir, state),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
    try {
      await waitFor(() => stdout, 'pong-1-tail-1');
      // The status bar prints once the turn has drained to `done`.
      await waitFor(() => stdout, '(2 msgs)');
      child.stdin.write('two\n');
      await waitFor(() => stdout, 'pong-2-tail-2');
      child.stdin.write('/exit\n');
      await exited;
    } catch (err) {
      child.kill();
      throw err;
    }
    expect(stdout).not.toMatch(/\[queued|\[interrupted/);
  }, 120_000);
});
