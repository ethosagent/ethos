import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { type ApprovalRequest, sanitizeForPrompt } from '../node-guard';
import { callFrame } from './fixtures';
import { useGuardFixture } from './node-guard-fixtures';

const frame = callFrame;

describe('NodeGuard.admit', () => {
  const fx = useGuardFixture();
  const { guard } = fx;
  let root: string;
  let home: string;
  let prompts: ApprovalRequest[];
  beforeEach(() => {
    ({ root, home, prompts } = fx);
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
