import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalRequest, NodePolicy } from '../node-guard';
import { callFrame, NOW } from './fixtures';
import { useGuardFixture } from './node-guard-fixtures';

const frame = callFrame;

const hasControl = (s: string): boolean =>
  [...s].some((c) => {
    const n = c.charCodeAt(0);
    return (n < 0x20 && n !== 0x0a && n !== 0x09) || (n >= 0x7f && n <= 0x9f);
  });

describe('NodeGuard.admit', () => {
  const fx = useGuardFixture();
  const { guard, refused } = fx;
  let root: string;
  let prompts: ApprovalRequest[];
  beforeEach(() => {
    ({ root, prompts } = fx);
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
