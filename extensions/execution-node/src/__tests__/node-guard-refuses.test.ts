import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest, CommandCheck } from '../node-guard';
import { callFrame, NOW } from './fixtures';
import { useGuardFixture } from './node-guard-fixtures';

const frame = callFrame;

describe('NodeGuard.admit', () => {
  const fx = useGuardFixture();
  const { guard, refused } = fx;
  let root: string;
  let roRoot: string;
  let outside: string;
  let prompts: ApprovalRequest[];
  beforeEach(() => {
    ({ root, roRoot, outside, prompts } = fx);
  });

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
      fx.answer = false;
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
});
