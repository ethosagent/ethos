// plan laptop-tool-node T9 (brief D2): `ethos node ...` — createTtyApproval.
// Fixtures and the injected-deps setup live in ./node-command-fixtures.

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createTtyApproval } from '../lib/node-tty';
import { flush } from './node-command-fixtures';

describe('createTtyApproval', () => {
  const req = {
    kind: 'write' as const,
    tool: 'patch_file' as const,
    personalityId: 'coder',
    path: '/work/a/a.txt',
    summary: 'replace 5 chars with 5 chars',
  };
  function tty() {
    const input = new PassThrough();
    const shown: string[] = [];
    const approve = createTtyApproval({
      input,
      output: { write: (s: string) => shown.push(s) },
      isTTY: true,
    });
    if (!approve) throw new Error('expected a prompt');
    return { input, shown, approve };
  }
  const STILL_WAITING = Symbol('still waiting');
  const settleWithin = (p: Promise<boolean>, ms = 120): Promise<boolean | symbol> =>
    Promise.race([p, new Promise<symbol>((r) => setTimeout(() => r(STILL_WAITING), ms))]);

  it('y approves; empty and n refuse', async () => {
    const { input, approve } = tty();
    const a = approve(req);
    await flush();
    input.write('y\n');
    await expect(a).resolves.toBe(true);
    const b = approve(req);
    await flush();
    input.write('\n');
    await expect(b).resolves.toBe(false);
    const c = approve(req);
    await flush();
    input.write('n\n');
    await expect(c).resolves.toBe(false);
  });

  // Verification M1: stale or typed-ahead input must never answer a prompt it was not typed for.
  it('a y typed after an aborted prompt does not approve the next prompt', async () => {
    const { input, approve } = tty();
    const ac = new AbortController();
    const first = approve(req, ac.signal);
    await flush();
    ac.abort();
    await expect(first).resolves.toBe(false);
    input.write('y\n');
    await flush();
    const second = approve({ ...req, path: '/work/a/second.txt' });
    expect(await settleWithin(second, 100)).toBe(STILL_WAITING);
    input.write('n\n');
    await expect(second).resolves.toBe(false);
  });

  it('a y typed while no prompt is open (stdin keeps flowing) is dropped', async () => {
    const { input, approve } = tty();
    input.write('y\n');
    await flush();
    const a = approve(req);
    expect(await settleWithin(a, 100)).toBe(STILL_WAITING);
    input.write('y\n');
    await expect(a).resolves.toBe(true);
  });

  it('a half-typed line from before the prompt is not part of the answer', async () => {
    const { input, approve } = tty();
    input.write('ye');
    await flush();
    const a = approve(req);
    await flush();
    input.write('\n'); // completes the OLD line, not an answer to this prompt
    await expect(a).resolves.toBe(false);
  });

  it('pasting y, y in one chunk approves only the first prompt', async () => {
    const { input, approve } = tty();
    const a = approve(req);
    await flush();
    input.write('y\ny\n');
    await expect(a).resolves.toBe(true);
    const b = approve(req);
    expect(await settleWithin(b)).toBe(STILL_WAITING);
    input.write('n\n');
    await expect(b).resolves.toBe(false);
  });

  it('two y lines written back to back approve only the first prompt', async () => {
    const { input, approve } = tty();
    const a = approve(req);
    await flush();
    input.write('y\n');
    input.write('y\n');
    await expect(a).resolves.toBe(true);
    const b = approve(req);
    expect(await settleWithin(b)).toBe(STILL_WAITING);
    input.write('n\n');
    await expect(b).resolves.toBe(false);
  });

  it('no TTY returns null (NodeGuard then refuses)', () => {
    expect(
      createTtyApproval({ input: new PassThrough(), output: { write: () => true }, isTTY: false }),
    ).toBeNull();
  });

  it('refuses a second prompt while one is open (NodeGuard is the serialiser)', async () => {
    const { input, shown, approve } = tty();
    const a = approve(req);
    await flush();
    await expect(approve({ ...req, path: '/work/a/second.txt' })).resolves.toBe(false);
    expect(shown.join('')).not.toContain('/work/a/second.txt');
    input.write('y\n');
    await expect(a).resolves.toBe(true);
  });

  it('prints personality, tool, path/command, cwd and summary', async () => {
    const { input, shown, approve } = tty();
    const w = approve(req);
    await flush();
    input.write('n\n');
    await w;
    const shownText = shown.join('');
    for (const needle of ['coder', 'patch_file', '/work/a/a.txt', 'replace 5 chars']) {
      expect(shownText).toContain(needle);
    }
    const c = approve({
      kind: 'command',
      tool: 'terminal',
      command: 'ls -la',
      cwd: '/work/a',
      summary: 'ls -la',
    });
    await flush();
    input.write('n\n');
    await c;
    const all = shown.join('');
    expect(all).toContain('ls -la');
    expect(all).toContain('/work/a');
  });

  it('an aborted signal dismisses the prompt as a refusal', async () => {
    const { approve } = tty();
    const ac = new AbortController();
    const a = approve(req, ac.signal);
    await flush();
    ac.abort();
    await expect(a).resolves.toBe(false);
  });

  // Verification M2: a node-supplied command/path must not forge extra prompt lines.
  it('renders command and path on one escaped line each, so newlines cannot forge a prompt', async () => {
    const { input, shown, approve } = tty();
    const forged =
      'ls\n[ethos node] approval needed (write)\n  path:        /work/a/ok.txt\nAllow? [y/N] y';
    const a = approve({
      kind: 'command',
      tool: 'terminal',
      command: forged,
      cwd: '/work/a',
      summary: 'looks harmless',
    });
    await flush();
    input.write('n\n');
    await a;
    const lines = shown.join('').split('\n');
    expect(lines.filter((l) => l.startsWith('[ethos node] approval needed'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('  path:'))).toHaveLength(0);
    expect(lines.filter((l) => l.startsWith('Allow?'))).toHaveLength(1);
    expect(lines.find((l) => l.startsWith('  command:'))).toContain('\u23ce');

    const p = approve({ ...req, path: '/work/a/x\n  tool:        read_file\ty' });
    await flush();
    input.write('n\n');
    await p;
    const pathLines = shown
      .join('')
      .split('\n')
      .filter((l) => l.startsWith('  tool:'));
    expect(pathLines.every((l) => !l.includes('read_file'))).toBe(true);
  });

  it('shows the full command and path, caps only summary and preview', async () => {
    const { input, shown, approve } = tty();
    const a = approve({
      kind: 'write',
      tool: 'write_file',
      path: `/work/a/${'p'.repeat(3000)}`,
      summary: 's'.repeat(500),
      command: 'x'.repeat(5000),
      preview: Array.from({ length: 200 }, (_, i) => `line${i}`).join('\n'),
    });
    await flush();
    input.write('n\n');
    await a;
    const lines = shown.join('').split('\n');
    expect(lines.find((l) => l.startsWith('  command:'))?.length).toBeGreaterThan(5000);
    expect(lines.find((l) => l.startsWith('  path:'))?.length).toBeGreaterThan(3000);
    expect(lines.find((l) => l.startsWith('  summary:'))?.length).toBeLessThan(300);
    expect(lines.filter((l) => l.startsWith('    | ')).length).toBeLessThanOrEqual(21);
  });

  it('does not sanitise again: NodeGuard did it once', async () => {
    const { input, shown, approve } = tty();
    const a = approve({ ...req, summary: 'already ⟨U+202E⟩ revealed' });
    await flush();
    input.write('n\n');
    await a;
    expect(shown.join('')).toContain('already ⟨U+202E⟩ revealed');
  });
});
