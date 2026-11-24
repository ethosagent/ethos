import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallFrame } from '../frames';
import {
  type ApprovalRequest,
  type CommandCheck,
  NodeGuard,
  type NodeGuardOptions,
  type NodePolicy,
  sanitizeForPrompt,
} from '../node-guard';
import { callFrame, NOW } from './fixtures';

const frame = callFrame;

const hasControl = (s: string): boolean =>
  [...s].some((c) => {
    const n = c.charCodeAt(0);
    return (n < 0x20 && n !== 0x0a && n !== 0x09) || (n >= 0x7f && n <= 0x9f);
  });

const safeCheck: CommandCheck = () => ({ dangerous: false });

describe('NodeGuard.admit', () => {
  let root: string;
  let roRoot: string;
  let outside: string;
  let home: string;
  let policy: NodePolicy;
  let prompts: ApprovalRequest[];
  let answer: boolean;

  function guard(over: Partial<NodeGuardOptions> = {}, pol: Partial<NodePolicy> = {}): NodeGuard {
    return new NodeGuard({
      policy: { ...policy, ...pol },
      approve: async (req) => {
        prompts.push(req);
        return answer;
      },
      checkCommand: safeCheck,
      now: () => NOW,
      home,
      ...over,
    });
  }

  beforeEach(() => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'node-guard-')));
    root = join(base, 'root');
    roRoot = join(base, 'ro');
    outside = join(base, 'outside');
    home = join(base, 'home');
    for (const d of [root, roRoot, outside, home, join(root, 'sub')])
      mkdirSync(d, { recursive: true });
    writeFileSync(join(root, 'a.txt'), 'hello');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    policy = {
      roots: [
        { path: root, readOnly: false },
        { path: roRoot, readOnly: true },
      ],
      tools: ['read_file', 'write_file', 'patch_file', 'search_files'],
      personalities: ['coder'],
      writes: 'ask',
      allowUnattended: false,
    };
    prompts = [];
    answer = true;
  });

  async function refused(g: NodeGuard, f: CallFrame) {
    const out = await g.admit(f);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected refusal');
    return out.result;
  }

  describe('refuses', () => {
    it('an unknown tool', async () => {
      const r = await refused(guard(), frame('run_code', { code: '1' }));
      expect(r).toMatchObject({ ok: false, code: 'not_available' });
    });
    it('terminal when it is not allowed', async () => {
      const r = await refused(guard(), frame('terminal', { command: 'ls' }));
      expect(r).toMatchObject({ ok: false, code: 'not_available' });
    });
    it('a personality that is not permitted', async () => {
      const r = await refused(
        guard(),
        frame('read_file', { path: 'a.txt' }, { req: { personalityId: 'writer' } }),
      );
      expect(r).toMatchObject({ ok: false, code: 'not_available' });
    });
    it('an undefined personalityId when the policy lists names', async () => {
      const r = await refused(
        guard(),
        frame('read_file', { path: 'a.txt' }, { req: { personalityId: undefined } }),
      );
      expect(r).toMatchObject({ ok: false, code: 'not_available' });
    });
    it('../ traversal', async () => {
      for (const p of ['../outside.txt', 'sub/../../x']) {
        const r = await refused(guard(), frame('read_file', { path: p }));
        expect(r).toMatchObject({ ok: false, code: 'execution_failed' });
        expect(r.ok === false && r.error).toMatch(/^PATH_NOT_REACHABLE/);
      }
    });
    it('~/x when ~ is outside the roots', async () => {
      const r = await refused(guard(), frame('read_file', { path: '~/x' }));
      expect(r.ok === false && r.error).toMatch(/^PATH_NOT_REACHABLE/);
    });
    it('an absolute path outside the roots', async () => {
      const r = await refused(guard(), frame('read_file', { path: join(outside, 'secret.txt') }));
      expect(r.ok === false && r.error).toMatch(/^PATH_NOT_REACHABLE/);
    });
    it('a write to a :ro root', async () => {
      for (const tool of ['write_file', 'patch_file']) {
        const args =
          tool === 'write_file'
            ? { path: join(roRoot, 'x.txt'), content: 'x' }
            : { path: join(roRoot, 'x.txt'), old_text: 'a', new_text: 'b' };
        const r = await refused(guard({}, { writes: 'auto' }), frame(tool, args));
        expect(r.ok === false && r.error).toMatch(/^PATH_NOT_REACHABLE/);
      }
    });
    it('read_file with an empty ref is admitted: strict-schema providers send "" for an unset optional (live smoke 2026-11-24)', async () => {
      const out = await guard().admit(frame('read_file', { ref: '', path: 'a.txt' }));
      expect(out.ok).toBe(true);
    });
    it('a duplicate callId', async () => {
      const g = guard();
      const first = await g.admit(frame('read_file', { path: 'a.txt' }, { callId: 'dup' }));
      expect(first.ok).toBe(true);
      const r = await refused(g, frame('read_file', { path: 'a.txt' }, { callId: 'dup' }));
      expect(r).toMatchObject({ ok: false, code: 'not_available' });
    });
    it('newConnection() clears the seen-callId set', async () => {
      const g = guard();
      await g.admit(frame('read_file', { path: 'a.txt' }, { callId: 'again' }));
      g.newConnection();
      const out = await g.admit(frame('read_file', { path: 'a.txt' }, { callId: 'again' }));
      expect(out.ok).toBe(true);
    });
    it('an expired deadline', async () => {
      const r = await refused(
        guard(),
        frame('read_file', { path: 'a.txt' }, { deadline: NOW - 1 }),
      );
      expect(r).toMatchObject({ ok: false, code: 'not_available' });
    });
    it("roomAudience 'shared'", async () => {
      const r = await refused(
        guard(),
        frame('read_file', { path: 'a.txt' }, { req: { roomAudience: 'shared' } }),
      );
      expect(r).toMatchObject({ ok: false, code: 'not_available' });
    });
    it("initiator 'system' without allowUnattended, and admits it with the flag", async () => {
      const f = () => frame('read_file', { path: 'a.txt' }, { req: { initiator: 'system' } });
      const r = await refused(guard(), f());
      expect(r).toMatchObject({ ok: false, code: 'not_available' });
      const out = await guard({}, { allowUnattended: true }).admit(f());
      expect(out.ok).toBe(true);
    });
    it('a write when approve is null (no TTY)', async () => {
      const r = await refused(
        guard({ approve: null }),
        frame('write_file', { path: 'n.txt', content: 'x' }),
      );
      expect(r.ok === false && r.error).toMatch(/no TTY/);
    });
    it('a write the prompt answers false', async () => {
      answer = false;
      const r = await refused(guard(), frame('write_file', { path: 'n.txt', content: 'x' }));
      expect(r).toMatchObject({ ok: false, code: 'execution_failed' });
      expect(r.ok === false && r.error).toMatch(/refused by the laptop owner/);
      expect(prompts).toHaveLength(1);
    });
    it('an approval prompt that never answers (timeout)', async () => {
      vi.useFakeTimers();
      try {
        const g = guard({ approve: () => new Promise<boolean>(() => {}) });
        const pending = g.admit(frame('write_file', { path: 'n.txt', content: 'x' }));
        await vi.advanceTimersByTimeAsync(300_001);
        const out = await pending;
        expect(out.ok).toBe(false);
        expect(out.ok === false && out.result.ok === false && out.result.error).toMatch(
          /timed out/,
        );
      } finally {
        vi.useRealTimers();
      }
    });
    it('terminal with a cwd outside the roots', async () => {
      const r = await refused(
        guard({}, { tools: ['terminal'] }),
        frame('terminal', { command: 'ls', cwd: outside }),
      );
      expect(r.ok === false && r.error).toMatch(/^PATH_NOT_REACHABLE/);
      expect(prompts).toHaveLength(0);
    });
    it('terminal cwd that is a symlink to outside a root (real-path check)', async () => {
      symlinkSync(outside, join(root, 'lnk'));
      const r = await refused(
        guard({}, { tools: ['terminal'] }),
        frame('terminal', { command: 'ls', cwd: join(root, 'lnk') }),
      );
      expect(r.ok === false && r.error).toMatch(/^PATH_NOT_REACHABLE/);
      expect(prompts).toHaveLength(0);
    });
    it('terminal cwd that does not exist', async () => {
      const r = await refused(
        guard({}, { tools: ['terminal'] }),
        frame('terminal', { command: 'ls', cwd: join(root, 'nope') }),
      );
      expect(r.ok).toBe(false);
      expect(prompts).toHaveLength(0);
    });
    it('a hardline command without prompting', async () => {
      const check: CommandCheck = () => ({ dangerous: true, reason: 'rm -rf /' });
      const r = await refused(
        guard({ checkCommand: check }, { tools: ['terminal'] }),
        frame('terminal', { command: 'rm -rf /' }),
      );
      expect(r.ok === false && r.error).toMatch(/rm -rf \//);
      expect(prompts).toHaveLength(0);
    });
    it('terminal when no checkCommand is wired', async () => {
      const r = await refused(
        guard({ checkCommand: undefined }, { tools: ['terminal'] }),
        frame('terminal', { command: 'ls' }),
      );
      expect(r.ok === false && r.error).toMatch(/terminal guard not wired/);
      expect(prompts).toHaveLength(0);
    });
    it('read_file with ref', async () => {
      const r = await refused(guard(), frame('read_file', { ref: 'att-0' }));
      expect(r).toMatchObject({ ok: false, code: 'input_invalid' });
    });
    it('NUL in a path and non-record args', async () => {
      const a = await refused(guard(), frame('read_file', { path: 'a\0.txt' }));
      expect(a).toMatchObject({ ok: false, code: 'input_invalid' });
      const b = await refused(guard(), frame('read_file', 'a.txt'));
      expect(b).toMatchObject({ ok: false, code: 'input_invalid' });
    });
    it('a symlinked file inside the root pointing outside, with no prompt', async () => {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'keys'));
      const r = await refused(
        guard({}, { writes: 'ask' }),
        frame('write_file', { path: 'keys', content: 'x' }),
      );
      expect(r.ok === false && r.error).toMatch(/^PATH_NOT_REACHABLE/);
      const r2 = await refused(guard(), frame('read_file', { path: 'keys' }));
      expect(r2).toMatchObject({ ok: false, code: 'execution_failed' });
      expect(r2.ok === false && r2.error).toMatch(/^PATH_NOT_REACHABLE/);
      expect(prompts).toHaveLength(0);
    });
  });

  describe('admits', () => {
    it('a read inside a root with no prompt, rewriting workingDir and args.path', async () => {
      const out = await guard().admit(frame('read_file', { path: 'a.txt', start_line: 1 }));
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.request.workingDir).toBe(root);
      expect(out.request.args).toEqual({ path: join(root, 'a.txt'), start_line: 1 });
      expect(prompts).toHaveLength(0);
    });
    it('%2e%2e/x as a literal child name', async () => {
      const out = await guard().admit(frame('read_file', { path: '%2e%2e/x' }));
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.request.args).toEqual({ path: join(root, '%2e%2e', 'x') });
    });
    it('~/ expanded against home when home is a root', async () => {
      const g = guard(
        {},
        {
          roots: [
            { path: root, readOnly: false },
            { path: home, readOnly: false },
          ],
        },
      );
      const out = await g.admit(frame('read_file', { path: '~/f.txt' }));
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.request.args).toEqual({ path: join(home, 'f.txt') });
    });
    it("a write with writes:'auto' and no prompt", async () => {
      const out = await guard({ approve: null }, { writes: 'auto' }).admit(
        frame('write_file', { path: 'n.txt', content: 'x' }),
      );
      expect(out.ok).toBe(true);
    });
    it("a write with writes:'ask' that the prompt approves", async () => {
      const out = await guard().admit(frame('write_file', { path: 'n.txt', content: 'héllo' }));
      expect(out.ok).toBe(true);
      expect(prompts).toEqual([
        {
          kind: 'write',
          tool: 'write_file',
          personalityId: 'coder',
          path: join(root, 'n.txt'),
          summary: '6 bytes',
          preview: 'héllo',
        },
      ]);
    });
    it('a patch prompt summarises the replacement', async () => {
      await guard().admit(
        frame('patch_file', { path: 'a.txt', old_text: 'hello\nmore', new_text: 'bye' }),
      );
      expect(prompts[0]?.summary).toBe("replace 10 chars with 3 chars: 'hello'");
    });
    it('search_files with no path uses the primary root', async () => {
      const out = await guard().admit(frame('search_files', { pattern: 'x' }));
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.request.args).toEqual({ pattern: 'x', path: root });
    });
    it('terminal after approval, rewriting cwd to the primary root', async () => {
      const out = await guard({}, { tools: ['terminal'] }).admit(
        frame('terminal', { command: 'ls' }),
      );
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.request.args).toEqual({ command: 'ls', cwd: root });
      expect(prompts[0]).toMatchObject({
        kind: 'command',
        tool: 'terminal',
        command: 'ls',
        cwd: root,
      });
    });
    it("personalities ['*'] admits any personality, including undefined", async () => {
      const g = guard({}, { personalities: ['*'] });
      const out = await g.admit(
        frame('read_file', { path: 'a.txt' }, { req: { personalityId: undefined } }),
      );
      expect(out.ok).toBe(true);
    });
  });

  describe('security hardening (verification M1-M5)', () => {
    it('M1: refuses a write into a nested :ro root, and its case-variant spelling', async () => {
      mkdirSync(join(root, 'secrets'), { recursive: true });
      const pol: Partial<NodePolicy> = {
        roots: [
          { path: root, readOnly: false },
          { path: join(root, 'secrets'), readOnly: true },
        ],
        writes: 'auto',
      };
      for (const dir of ['secrets', 'SECRETS', 'Secrets']) {
        const r = await refused(
          guard({}, pol),
          frame('write_file', { path: join(root, dir, 'x.txt'), content: 'x' }),
        );
        expect(r.ok === false && r.error).toMatch(/^PATH_NOT_REACHABLE/);
      }
      const read = await guard({}, pol).admit(
        frame('read_file', { path: join(root, 'secrets', 'x.txt') }),
      );
      expect(read.ok).toBe(true);
      const sibling = await guard({}, pol).admit(
        frame('write_file', { path: join(root, 'sub', 'x.txt'), content: 'x' }),
      );
      expect(sibling.ok).toBe(true);
    });

    it('M2: refuses a frame with no initiator; admits user, and system only when allowed', async () => {
      const f = (initiator: 'user' | 'system' | undefined) =>
        frame('read_file', { path: 'a.txt' }, { req: { initiator } });
      expect((await guard().admit(f(undefined))).ok).toBe(false);
      expect((await guard().admit(f('user'))).ok).toBe(true);
      expect((await guard().admit(f('system'))).ok).toBe(false);
      expect((await guard({}, { allowUnattended: true }).admit(f('system'))).ok).toBe(true);
    });

    it('minor 3: refuses a deadline more than 15 min + grace ahead, without remembering the callId', async () => {
      const g = guard();
      const far = NOW + 15 * 60_000 + 60_001;
      const r = await refused(
        g,
        frame('read_file', { path: 'a.txt' }, { deadline: far, callId: 'far' }),
      );
      expect(r).toMatchObject({ ok: false, code: 'not_available' });
      const ok = await g.admit(
        frame('read_file', { path: 'a.txt' }, { deadline: NOW + 15 * 60_000, callId: 'far' }),
      );
      expect(ok.ok).toBe(true);
    });

    it('M5c: strips control chars, ESC and CR from the command, path and summary shown to the owner', async () => {
      await guard({}, { tools: ['terminal'] }).admit(
        frame('terminal', { command: 'echo \x1b[2Jhi\r\x07there\x85x' }),
      );
      expect(prompts[0]?.command).toBe('echo [2Jhitherex');
      expect(hasControl(prompts[0]?.summary ?? '')).toBe(false);
      prompts.length = 0;
      await guard().admit(frame('write_file', { path: 'we\x1b]0;pwn\x07ird.txt', content: 'x' }));
      expect(hasControl(prompts[0]?.path ?? '')).toBe(false);
    });

    it('M5d: shows a bounded sanitised preview of write content and patch old/new text', async () => {
      const content = `${Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')}\x1b[31m`;
      await guard().admit(frame('write_file', { path: 'n.txt', content }));
      const wp = prompts[0]?.preview ?? '';
      expect(wp).toContain('line 0');
      expect(wp).toContain('line 19');
      expect(wp).not.toContain('line 20');
      expect(wp).not.toContain('\x1b');
      prompts.length = 0;
      await guard().admit(frame('write_file', { path: 'n.txt', content: 'y'.repeat(100_000) }));
      expect(Buffer.byteLength(prompts[0]?.preview ?? '')).toBeLessThan(2048);
      prompts.length = 0;
      await guard().admit(
        frame('patch_file', { path: 'a.txt', old_text: 'OLDTEXT', new_text: 'NEWTEXT' }),
      );
      expect(prompts[0]?.preview).toContain('OLDTEXT');
      expect(prompts[0]?.preview).toContain('NEWTEXT');
    });

    it('shows hidden characters in the approval request as markers', async () => {
      await guard({}, { tools: ['terminal'] }).admit(
        frame('terminal', { command: 'rm \u202e txt.sh \u200b x' }),
      );
      expect(prompts[0]?.command).toBe('rm ⟨U+202E⟩ txt.sh ⟨U+200B⟩ x');
      expect(prompts[0]?.command).not.toMatch(/[\u202e\u200b]/);
    });

    it('does not truncate a long command and refuses one over 8 KiB', async () => {
      const long = `echo ${'a'.repeat(6000)}`;
      await guard({}, { tools: ['terminal'] }).admit(frame('terminal', { command: long }));
      expect(prompts[0]?.command).toBe(long);
      prompts.length = 0;
      const r = await guard({}, { tools: ['terminal'] }).admit(
        frame('terminal', { command: `echo ${'a'.repeat(8200)}` }),
      );
      expect(r).toMatchObject({ ok: false, result: { code: 'input_invalid', field: 'command' } });
      expect(prompts).toHaveLength(0);
    });

    it('refuses a path over 4 KiB', async () => {
      const r = await guard().admit(
        frame('write_file', { path: `${'d/'.repeat(2100)}f`, content: 'x' }),
      );
      expect(r).toMatchObject({ ok: false, result: { code: 'input_invalid', field: 'path' } });
      expect(prompts).toHaveLength(0);
    });

    it('refuses the ninth waiting approval', async () => {
      const resolvers: ((v: boolean) => void)[] = [];
      const g = guard({
        approve: () => new Promise<boolean>((res) => resolvers.push(res)),
      });
      const waiting = Array.from({ length: 8 }, (_, i) =>
        g.admit(frame('write_file', { path: `w${i}.txt`, content: 'x' })),
      );
      await new Promise((r) => setTimeout(r, 20));
      const ninth = await g.admit(frame('write_file', { path: 'w9.txt', content: 'x' }));
      expect(ninth).toMatchObject({ ok: false, result: { code: 'not_available' } });
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 5));
        resolvers[i]?.(false);
      }
      await Promise.all(waiting);
      // The queue drained: a new call prompts again.
      const again = g.admit(frame('write_file', { path: 'w10.txt', content: 'x' }));
      await new Promise((r) => setTimeout(r, 20));
      expect(resolvers).toHaveLength(9);
      resolvers[8]?.(true);
      expect((await again).ok).toBe(true);
    });

    it('refuses a queued call whose deadline passed while it waited', async () => {
      let clock = NOW;
      const resolvers: ((v: boolean) => void)[] = [];
      const g = guard({
        now: () => clock,
        approve: () => new Promise<boolean>((res) => resolvers.push(res)),
      });
      const first = g.admit(frame('write_file', { path: 'q1.txt', content: 'x' }));
      const second = g.admit(
        frame('write_file', { path: 'q2.txt', content: 'x' }, { deadline: NOW + 1000 }),
      );
      await new Promise((r) => setTimeout(r, 20));
      clock = NOW + 5000;
      resolvers[0]?.(true);
      expect((await first).ok).toBe(true);
      expect(await second).toMatchObject({ ok: false, result: { code: 'not_available' } });
      expect(resolvers).toHaveLength(1); // the expired call never drew a prompt
    });

    it('M5a: serialises approvals so only one prompt is outstanding', async () => {
      let active = 0;
      let maxActive = 0;
      const resolvers: ((v: boolean) => void)[] = [];
      const g = guard({
        approve: () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          return new Promise<boolean>((res) =>
            resolvers.push((v) => {
              active -= 1;
              res(v);
            }),
          );
        },
      });
      const a = g.admit(frame('write_file', { path: 'a1.txt', content: 'x' }));
      const b = g.admit(frame('write_file', { path: 'a2.txt', content: 'x' }));
      const c = g.admit(frame('write_file', { path: 'a3.txt', content: 'x' }));
      await new Promise((r) => setTimeout(r, 20));
      expect(resolvers).toHaveLength(1);
      resolvers[0]?.(true);
      await a;
      await new Promise((r) => setTimeout(r, 20));
      expect(resolvers).toHaveLength(2);
      resolvers[1]?.(false);
      await b;
      await new Promise((r) => setTimeout(r, 20));
      resolvers[2]?.(true);
      expect((await a).ok).toBe(true);
      expect((await b).ok).toBe(false);
      expect((await c).ok).toBe(true);
      expect(maxActive).toBe(1);
    });

    it('M5b: aborting a call aborts its outstanding prompt and dequeues a queued one', async () => {
      const signals: AbortSignal[] = [];
      let calls = 0;
      const g = guard({
        approve: (_req, signal) => {
          calls += 1;
          if (signal) signals.push(signal);
          return new Promise<boolean>(() => {});
        },
      });
      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const first = g.admit(frame('write_file', { path: 'a1.txt', content: 'x' }), ac1.signal);
      const queued = g.admit(frame('write_file', { path: 'a2.txt', content: 'x' }), ac2.signal);
      await new Promise((r) => setTimeout(r, 20));
      expect(calls).toBe(1);
      ac2.abort();
      const q = await queued;
      expect(q.ok).toBe(false);
      expect(calls).toBe(1); // the queued prompt never opened
      ac1.abort();
      const f = await first;
      expect(signals[0]?.aborted).toBe(true);
      expect(f.ok).toBe(false);
      expect(f.ok === false && f.result.ok === false && f.result.error).toMatch(/cancelled/);
    });
  });
});

// Verification M2: format/bidi characters can reorder or hide what the owner reads at the prompt.
describe('sanitizeForPrompt', () => {
  it('strips controls but REVEALS format characters as visible markers; keeps text, newline, tab', () => {
    const dirty = 'a\u202eb\u202ac\u2066d\u2069e\u200bf\ufeffg\u00adh\u001bi\u0085j\nk\tl';
    expect(sanitizeForPrompt(dirty)).toBe(
      'a⟨U+202E⟩b⟨U+202A⟩c⟨U+2066⟩d⟨U+2069⟩e⟨U+200B⟩f⟨U+FEFF⟩g⟨U+00AD⟩hij\nk\tl',
    );
  });
  it('reveals tag characters and other format characters', () => {
    expect(sanitizeForPrompt('x\u{e0041}y')).toBe('x⟨U+E0041⟩y');
    expect(sanitizeForPrompt('x\u0600y')).toBe('x⟨U+0600⟩y');
  });
});
