// Shared setup for the `memory <cmd> --json` tests: a temp ETHOS_STATE_DIR with a muse scope,
// stdout captured as text, process.exit turned into a throw, and a one-document assertion.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';

export const EXIT = 'process.exit';

export interface JsonCliHarness {
  scopeDir: string;
  stdout(): string;
  stderr(): string;
  teardown(): Promise<void>;
}

export async function setupJsonCli(prefix: string): Promise<JsonCliHarness> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const scopeDir = join(root, 'personalities', 'muse');
  await mkdir(scopeDir, { recursive: true });
  await writeFile(
    join(root, 'config.yaml'),
    'schemaVersion: 1\nprovider: anthropic\nmodel: claude-test\napiKey: sk-test\npersonality: muse\n',
  );
  const prevStateDir = process.env.ETHOS_STATE_DIR;
  process.env.ETHOS_STATE_DIR = root;
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`${EXIT}(${code})`);
  }) as never);
  // console.log lands in the same buffer so a stray log in JSON mode breaks parseOneDoc.
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(`${a.join(' ')}\n`);
  });
  const err: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(`${a.join(' ')}\n`);
  });
  return {
    scopeDir,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    async teardown() {
      vi.restoreAllMocks();
      if (prevStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
      else process.env.ETHOS_STATE_DIR = prevStateDir;
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Asserts none of `needles` (a secret) reached raw stdout or stderr, in any form. */
export function expectNoSecret(h: JsonCliHarness, ...needles: string[]): void {
  for (const needle of needles) {
    expect(h.stdout()).not.toContain(needle);
    expect(h.stderr()).not.toContain(needle);
  }
}

/** Asserts stdout holds exactly one line and returns it parsed. */
export interface JsonDoc {
  ok: boolean;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

export function parseOneDoc(h: JsonCliHarness): JsonDoc {
  const text = h.stdout();
  expect(text.trim().split('\n')).toHaveLength(1);
  return JSON.parse(text);
}
