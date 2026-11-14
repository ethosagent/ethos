// `/rewind` through the real `ethos chat` readline loop (review finding M4/M10):
// the prefill is pending until the next line decides it. ANY `/`-prefixed line
// (including the busy-slashes `/steer` and `/busy`, which skip
// `handleSlashCommand`) cancels it; a plain line commits it onto a new branch.
//
// Driven as a REAL process like chat-piped-exit.test.ts. Piped stdin is not a
// terminal, so `rl.write(prefill)` lands in the line buffer and the next line
// arrives as `<prefill><typed>`. The seeded prompts are chosen to make that
// merge meaningful: the cancel case seeds a prompt that itself starts with
// `/steer`, so the merged line is a busy-slash exactly as a user's Enter on an
// edited `/steer …` would be.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const CLI = join(ROOT, 'apps', 'ethos', 'src', 'index.ts');

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function seed(state: string, prompts: string[]): Promise<void> {
  const store = new SQLiteSessionStore(join(state, 'sessions.db'));
  try {
    const s = await store.createSession({
      key: `cli:${basename(ROOT)}`,
      platform: 'cli',
      model: 'test',
      provider: 'anthropic',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
      },
    });
    for (const p of prompts) {
      await store.appendMessage({ sessionId: s.id, role: 'user', content: p });
      await store.appendMessage({ sessionId: s.id, role: 'assistant', content: `re: ${p}` });
    }
  } finally {
    store.close();
  }
}

/** Run `ethos chat`, sending each line only after `waitFor` shows up in stdout. */
async function drive(
  prompts: string[],
  steps: Array<{ send: string; waitFor: string }>,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ethos-chat-rewind-'));
  dirs.push(dir);
  const state = join(dir, 'state');
  await mkdir(join(dir, 'home'), { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(
    join(state, 'config.yaml'),
    [
      'schemaVersion: 1',
      'provider: anthropic',
      'apiKey: sk-ant-test-000',
      'baseUrl: http://127.0.0.1:1',
      'model: test',
      '',
    ].join('\n'),
  );
  await seed(state, prompts);
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'chat'], {
    cwd: ROOT,
    env: { ...process.env, HOME: join(dir, 'home'), ETHOS_STATE_DIR: state, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => {
    out += String(d);
  });
  child.stderr.on('data', (d) => {
    out += String(d);
  });
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ethos chat did not exit:\n${out}`));
    }, 90_000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const until = async (needle: string, from: number) => {
    const deadline = Date.now() + 60_000;
    while (!out.includes(needle, from)) {
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${out}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  for (const step of steps) {
    const from = out.length;
    child.stdin.write(`${step.send}\n`);
    await until(step.waitFor, from);
  }
  child.stdin.end();
  await exited;
  return out;
}

describe('ethos chat /rewind through readline', () => {
  it('a /steer line after the prefill cancels the rewind instead of committing it', async () => {
    const out = await drive(
      ['/steer keep going'],
      [
        { send: '/rewind 1', waitFor: 'Editing prompt 1 back' },
        // Arrives as "/steer keep going" + " now": a busy-slash line.
        { send: ' now', waitFor: '[rewind cancelled]' },
      ],
    );
    expect(out).toContain('[rewind cancelled]');
    expect(out).not.toContain('now on a new branch');
  }, 150_000);

  it('a plain line after the prefill commits the rewind onto a new branch', async () => {
    const out = await drive(
      ['first prompt', 'second prompt'],
      [
        { send: '/rewind 1', waitFor: 'Editing prompt 1 back' },
        { send: ' edited', waitFor: 'now on a new branch' },
      ],
    );
    expect(out).toContain('Rewound');
    expect(out).not.toContain('[rewind cancelled]');
  }, 150_000);
});
