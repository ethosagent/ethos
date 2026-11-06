import { existsSync } from 'node:fs';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeTreeDigest,
  fetchGitTreeDigest,
  GitPinFetchError,
  GitPinInputError,
  GitPinMismatchError,
  GitPinRefusedError,
  type GitRunner,
  isGithubRepoUrl,
  MAX_GIT_PIN_FILES,
  withGitPinnedTree,
} from '../git-pin';

const COMMIT = 'a'.repeat(40);
const REPO = 'https://github.com/acme/skills';

type Tree = Record<string, string | { content: string; exec?: boolean }>;

/** A GitRunner whose `checkout` materialises `tree` (in `order`) into the scratch dir. */
function fakeGit(
  tree: Tree,
  opts: {
    lsTree?: string;
    head?: string;
    failFetch?: boolean;
    after?: (cwd: string) => Promise<void>;
  } = {},
) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const scratches: string[] = [];
  const runGit: GitRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    if (!scratches.includes(cwd)) scratches.push(cwd);
    switch (args[0]) {
      case 'fetch':
        if (opts.failFetch) throw new Error('fatal: not our ref');
        return '';
      case 'checkout':
        for (const [rel, v] of Object.entries(tree)) {
          const abs = join(cwd, rel);
          await mkdir(join(abs, '..'), { recursive: true });
          const f = typeof v === 'string' ? { content: v } : v;
          await writeFile(abs, f.content);
          if ('exec' in f && f.exec) await chmod(abs, 0o755);
        }
        await opts.after?.(cwd);
        return '';
      case 'rev-parse':
        return `${opts.head ?? COMMIT}\n`;
      case 'ls-tree':
        return opts.lsTree ?? '';
      default:
        return '';
    }
  };
  return { runGit, calls, scratches };
}

const base = { repo: REPO, commit: COMMIT };

async function digestOf(tree: Tree, subdir?: string): Promise<string> {
  const g = fakeGit(tree);
  return fetchGitTreeDigest({ ...base, ...(subdir ? { subdir } : {}) }, { runGit: g.runGit });
}

describe('withGitPinnedTree', () => {
  it('digest is stable across file creation order and has the sha256-base64 shape', async () => {
    const a = await digestOf({ 'x/SKILL.md': 'hi', 'x/b.txt': 'b', 'x/a.txt': 'a' }, 'x');
    const b = await digestOf({ 'x/a.txt': 'a', 'x/b.txt': 'b', 'x/SKILL.md': 'hi' }, 'x');
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
  });

  it('digest changes with content, with path, and with the exec bit', async () => {
    const ref = await digestOf({ 'SKILL.md': 'one' });
    expect(await digestOf({ 'SKILL.md': 'two' })).not.toBe(ref);
    expect(await digestOf({ 'OTHER.md': 'one' })).not.toBe(ref);
    expect(await digestOf({ 'SKILL.md': { content: 'one', exec: true } })).not.toBe(ref);
  });

  it('runs git as init, fetch --depth 1 <repo> <commit>, checkout FETCH_HEAD, with an argv array', async () => {
    const g = fakeGit({ 'SKILL.md': 'hi' });
    const digest = await digestOf({ 'SKILL.md': 'hi' });
    await withGitPinnedTree({ ...base, contentDigest: digest }, async () => undefined, {
      runGit: g.runGit,
    });
    const argvs = g.calls.map((c) => c.args);
    expect(argvs[0]).toEqual(['init', '-q']);
    expect(argvs[1]).toEqual(['fetch', '-q', '--depth', '1', '--no-tags', REPO, COMMIT]);
    expect(argvs[2]).toEqual(['checkout', '-q', 'FETCH_HEAD']);
  });

  it('hands fn the subdir, then removes the scratch directory', async () => {
    const tree = { 'skills/pdf/SKILL.md': 'hi' };
    const digest = await digestOf(tree, 'skills/pdf');
    const g = fakeGit(tree);
    let seen = '';
    await withGitPinnedTree(
      { ...base, subdir: 'skills/pdf', contentDigest: digest },
      async (dir) => {
        seen = dir;
        expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);
      },
      { runGit: g.runGit },
    );
    expect(seen.endsWith(join('skills', 'pdf'))).toBe(true);
    expect(existsSync(g.scratches[0] as string)).toBe(false);
  });

  it('a digest mismatch throws GitPinMismatchError, never calls fn, and removes the scratch directory', async () => {
    const g = fakeGit({ 'SKILL.md': 'hi' });
    let called = false;
    const err = await withGitPinnedTree(
      { ...base, contentDigest: `sha256-${'A'.repeat(43)}=` },
      async () => {
        called = true;
      },
      { runGit: g.runGit },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitPinMismatchError);
    expect(called).toBe(false);
    expect(existsSync(g.scratches[0] as string)).toBe(false);
  });

  it('removes the scratch directory when fn throws', async () => {
    const tree = { 'SKILL.md': 'hi' };
    const digest = await digestOf(tree);
    const g = fakeGit(tree);
    await expect(
      withGitPinnedTree(
        { ...base, contentDigest: digest },
        async () => {
          throw new Error('boom');
        },
        { runGit: g.runGit },
      ),
    ).rejects.toThrow('boom');
    expect(existsSync(g.scratches[0] as string)).toBe(false);
  });

  it('refuses a symlink in the checkout', async () => {
    const g = fakeGit(
      { 'SKILL.md': 'hi' },
      { after: (cwd) => symlink('/etc/passwd', join(cwd, 'link')) },
    );
    await expect(fetchGitTreeDigest(base, { runGit: g.runGit })).rejects.toBeInstanceOf(
      GitPinRefusedError,
    );
  });

  it('refuses a symlink or gitlink recorded in the commit tree, and a .gitmodules file', async () => {
    const link = '120000 blob abc\tsub/link\0';
    const gitlink = '160000 commit abc\tsub/mod\0';
    const modules = '100644 blob abc\t.gitmodules\0';
    for (const lsTree of [link, gitlink, modules]) {
      const g = fakeGit({ 'sub/SKILL.md': 'hi' }, { lsTree });
      await expect(
        fetchGitTreeDigest({ ...base, subdir: 'sub' }, { runGit: g.runGit }),
      ).rejects.toBeInstanceOf(GitPinRefusedError);
    }
  });

  it('ignores a symlink recorded outside the pinned subdir', async () => {
    const g = fakeGit({ 'sub/SKILL.md': 'hi' }, { lsTree: '120000 blob abc\tother/link\0' });
    await expect(
      fetchGitTreeDigest({ ...base, subdir: 'sub' }, { runGit: g.runGit }),
    ).resolves.toMatch(/^sha256-/);
  });

  it('refuses a file over 1 MiB', async () => {
    const g = fakeGit({ 'big.bin': 'x'.repeat(1024 * 1024 + 1) });
    await expect(fetchGitTreeDigest(base, { runGit: g.runGit })).rejects.toBeInstanceOf(
      GitPinRefusedError,
    );
  });

  it('accepts a file of exactly 1 MiB', async () => {
    const g = fakeGit({ 'big.bin': 'x'.repeat(1024 * 1024) });
    await expect(fetchGitTreeDigest(base, { runGit: g.runGit })).resolves.toMatch(/^sha256-/);
  });

  it('refuses more than MAX_GIT_PIN_FILES files, and accepts exactly that many', async () => {
    const many = (n: number): Tree =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`f/${i}.txt`, String(i)]));
    const over = fakeGit(many(MAX_GIT_PIN_FILES + 1));
    await expect(fetchGitTreeDigest(base, { runGit: over.runGit })).rejects.toBeInstanceOf(
      GitPinRefusedError,
    );
    const exact = fakeGit(many(MAX_GIT_PIN_FILES));
    await expect(fetchGitTreeDigest(base, { runGit: exact.runGit })).resolves.toMatch(/^sha256-/);
  }, 60_000);

  it('refuses an empty subtree and a missing subdir', async () => {
    const empty = fakeGit({ 'other/a': 'a' });
    await expect(
      fetchGitTreeDigest({ ...base, subdir: 'nope' }, { runGit: empty.runGit }),
    ).rejects.toBeInstanceOf(GitPinRefusedError);
  });

  it('a failed fetch is GitPinFetchError and still cleans up', async () => {
    const g = fakeGit({}, { failFetch: true });
    await expect(fetchGitTreeDigest(base, { runGit: g.runGit })).rejects.toBeInstanceOf(
      GitPinFetchError,
    );
    expect(existsSync(g.scratches[0] as string)).toBe(false);
  });

  it('a HEAD that is not the pinned commit is GitPinFetchError', async () => {
    const g = fakeGit({ a: 'a' }, { head: 'b'.repeat(40) });
    await expect(fetchGitTreeDigest(base, { runGit: g.runGit })).rejects.toBeInstanceOf(
      GitPinFetchError,
    );
  });

  it('refuses malformed pins before git is spawned', async () => {
    const digest = `sha256-${'A'.repeat(43)}=`;
    const bad: Array<
      Partial<{ repo: string; commit: string; subdir: string; contentDigest: string }>
    > = [
      { repo: 'https://gitlab.com/acme/skills' },
      { repo: 'http://github.com/acme/skills' },
      { repo: 'https://github.com/acme/skills/extra' },
      { repo: 'https://github.com/../skills' },
      { repo: 'https://github.com/acme/.hidden' },
      { repo: 'https://github.com/acme/skills.git?x=1' },
      { repo: 'git@github.com:acme/skills' },
      { commit: 'main' },
      { commit: 'A'.repeat(40) },
      { commit: 'a'.repeat(39) },
      { subdir: '../etc' },
      { subdir: '/abs' },
      { subdir: 'a//b' },
      { contentDigest: 'sha256-short' },
      { contentDigest: 'sha512-abc' },
    ];
    for (const patch of bad) {
      const g = fakeGit({ 'SKILL.md': 'hi' });
      await expect(
        withGitPinnedTree({ ...base, contentDigest: digest, ...patch }, async () => undefined, {
          runGit: g.runGit,
        }),
      ).rejects.toBeInstanceOf(GitPinInputError);
      expect(g.calls).toEqual([]);
    }
  });
});

describe('isGithubRepoUrl', () => {
  it('accepts plain owner/repo and rejects everything else', () => {
    expect(isGithubRepoUrl('https://github.com/anthropics/skills')).toBe(true);
    expect(isGithubRepoUrl('https://github.com/a-b/c_d.e')).toBe(true);
    expect(isGithubRepoUrl('https://github.com/anthropics')).toBe(false);
    expect(isGithubRepoUrl('https://github.com/anthropics/skills/')).toBe(false);
    expect(isGithubRepoUrl('https://github.com/a b/c')).toBe(false);
  });
});

describe('computeTreeDigest', () => {
  it('is independent of directory read order (same files, different creation order)', async () => {
    const mk = async (order: string[]) => {
      const g = fakeGit(Object.fromEntries(order.map((n) => [n, n])));
      return fetchGitTreeDigest(base, { runGit: g.runGit });
    };
    expect(await mk(['c', 'a', 'b'])).toBe(await mk(['a', 'b', 'c']));
    expect(typeof computeTreeDigest).toBe('function');
  });
});
