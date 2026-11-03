// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${ETHOS_HOME}` in a
// test name is an fs_reach substitution token, not a JS template.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acpWorkspacePaths,
  assertWorkspaceInReach,
  type CommandRunner,
  prepareWorkspace,
  spawnCapture,
  WorkspaceOutOfReachError,
} from '../worktree';

const JOB = 'job-1234';
const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-worktree-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('acpWorkspacePaths', () => {
  it('puts the run under ${ETHOS_HOME}/worktrees keyed by job id', () => {
    const paths = acpWorkspacePaths('/home/u/.ethos', JOB);
    expect(paths).toEqual({
      root: '/home/u/.ethos/worktrees',
      workspace: '/home/u/.ethos/worktrees/job-1234',
      sessionDir: '/home/u/.ethos/worktrees/job-1234.session',
    });
  });

  it('keeps the session store OUT of the worktree so the run diff stays clean', () => {
    const paths = acpWorkspacePaths('/home/u/.ethos', JOB);
    expect(paths.sessionDir.startsWith(`${paths.workspace}/`)).toBe(false);
    expect(paths.sessionDir.startsWith(`${paths.root}/`)).toBe(true);
  });

  it('gives two jobs two workspaces — a run never shares a tree', () => {
    const a = acpWorkspacePaths('/home/u/.ethos', 'a');
    const b = acpWorkspacePaths('/home/u/.ethos', 'b');
    expect(a.workspace).not.toBe(b.workspace);
  });

  it('shares the same worktrees root a Pi job would use, keyed by the same job id space', () => {
    // D24 generalization claim: the id space is the shared JobStore's, not
    // per-runner, so an ACP job and a Pi job never collide under one root.
    const acp = acpWorkspacePaths('/home/u/.ethos', 'shared-job-1');
    expect(acp.root).toBe('/home/u/.ethos/worktrees');
    expect(acp.workspace).toBe('/home/u/.ethos/worktrees/shared-job-1');
  });
});

describe('assertWorkspaceInReach', () => {
  const workspace = '/home/u/.ethos/worktrees/job-1234';

  it('accepts a workspace under a declared reach entry', () => {
    expect(() =>
      assertWorkspaceInReach('scribe', workspace, ['/home/u/.ethos/worktrees/']),
    ).not.toThrow();
  });

  it('refuses when the personality never declared the worktrees root', () => {
    expect(() =>
      assertWorkspaceInReach('scribe', workspace, ['/home/u/.ethos/personalities/scribe/']),
    ).toThrow(WorkspaceOutOfReachError);
  });

  it('names the entry the operator has to add', () => {
    expect(() => assertWorkspaceInReach('scribe', workspace, [])).toThrow(/fs_reach\.write/);
  });

  it('does not accept a sibling directory that merely shares a prefix string', () => {
    expect(() =>
      assertWorkspaceInReach('scribe', '/home/u/.ethos/worktrees-public/x', [
        '/home/u/.ethos/worktrees',
      ]),
    ).toThrow(WorkspaceOutOfReachError);
  });
});

describe('prepareWorkspace', () => {
  it('creates a real git worktree when the source workdir is a repository', async () => {
    const repo = tempDir();
    const ethosHome = tempDir();
    const run: CommandRunner = spawnCapture;
    await run('git', ['-C', repo, 'init', '-q']);
    await run('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    await run('git', ['-C', repo, 'config', 'user.name', 'test']);
    writeFileSync(join(repo, 'tracked.txt'), 'original\n');
    await run('git', ['-C', repo, 'add', '.']);
    await run('git', ['-C', repo, 'commit', '-qm', 'init']);

    const paths = acpWorkspacePaths(ethosHome, JOB);
    const prepared = await prepareWorkspace(paths, repo);

    expect(prepared.sourceRepo).toBeTruthy();
    expect(readFileSync(join(prepared.workspace, 'tracked.txt'), 'utf-8')).toBe('original\n');
    writeFileSync(join(prepared.workspace, 'tracked.txt'), 'changed\n');
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf-8')).toBe('original\n');
  });

  it('falls back to a fresh empty directory when the workdir is not a repository', async () => {
    const plain = tempDir();
    writeFileSync(join(plain, 'parent.txt'), 'do not share me\n');
    const paths = acpWorkspacePaths(tempDir(), JOB);

    const prepared = await prepareWorkspace(paths, plain);

    expect(prepared.sourceRepo).toBeUndefined();
    expect(prepared.workspace).not.toBe(plain);
    expect(() => readFileSync(join(prepared.workspace, 'parent.txt'), 'utf-8')).toThrow();
  });

  it('reuses an existing workspace, so a Resume lands on the same tree', async () => {
    const paths = acpWorkspacePaths(tempDir(), JOB);
    await prepareWorkspace(paths, tempDir());
    writeFileSync(join(paths.workspace, 'partial.txt'), 'work so far\n');

    await prepareWorkspace(paths, tempDir());

    expect(readFileSync(join(paths.workspace, 'partial.txt'), 'utf-8')).toBe('work so far\n');
  });

  it('reports the git failure rather than silently running in an empty directory', async () => {
    const failing: CommandRunner = async (_cmd, args) => {
      if (args.includes('--show-toplevel')) return { code: 0, stdout: '/some/repo\n', stderr: '' };
      if (args.includes('--git-common-dir')) {
        return { code: 0, stdout: `${'a'.repeat(40)}\nsha1\n.git\n`, stderr: '' };
      }
      return { code: 128, stdout: '', stderr: 'fatal: it already exists' };
    };
    const paths = acpWorkspacePaths(tempDir(), JOB);
    await expect(prepareWorkspace(paths, '/some/repo', failing)).rejects.toThrow(
      /git worktree add failed/,
    );
  });

  it('refuses a repository with no commits instead of leaving an empty worktree', async () => {
    const repo = tempDir();
    git(repo, 'init', '-q');
    await expect(prepareWorkspace(acpWorkspacePaths(tempDir(), JOB), repo)).rejects.toThrow(
      /git worktree add failed/,
    );
  });

  it('a fixture repo configured to create a marker file on checkout leaves no marker after prepareWorkspace', async () => {
    const repo = tempDir();
    const markers = tempDir();
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'test');
    writeFileSync(join(repo, '.gitattributes'), '* filter=marker\n');
    writeFileSync(join(repo, 'a.txt'), 'content\n');
    mkdirSync(join(repo, 'dir'));
    writeFileSync(join(repo, 'dir', 'b.txt'), 'nested\n');
    git(repo, 'config', 'filter.marker.smudge', `touch ${markers}/smudge; cat`);
    git(repo, 'config', 'filter.marker.clean', `touch ${markers}/clean; cat`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    // The fixture's own setup ran the filters; only what prepareWorkspace does counts.
    for (const name of readdirSync(markers)) rmSync(join(markers, name));

    const hook = join(repo, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\ntouch ${markers}/post-checkout\n`);
    chmodSync(hook, 0o755);
    const fsmonitor = join(repo, '.git', 'fsmonitor.sh');
    writeFileSync(fsmonitor, `#!/bin/sh\ntouch ${markers}/fsmonitor\n`);
    chmodSync(fsmonitor, 0o755);
    git(repo, 'config', 'core.fsmonitor', fsmonitor);
    // `worktree add --no-checkout` still fires `reference-transaction`, so the
    // `-c core.hooksPath=/dev/null` override is load-bearing: pin it, both for a
    // hook in the default hooks dir and for a hooksPath set via `include.path`.
    const refHook = join(repo, '.git', 'hooks', 'reference-transaction');
    writeFileSync(refHook, `#!/bin/sh\ntouch ${markers}/reference-transaction\n`);
    chmodSync(refHook, 0o755);
    const includedHooks = tempDir();
    const includedHook = join(includedHooks, 'reference-transaction');
    writeFileSync(includedHook, `#!/bin/sh\ntouch ${markers}/included-hooks-path\n`);
    chmodSync(includedHook, 0o755);
    const included = join(tempDir(), 'extra.gitconfig');
    writeFileSync(included, `[core]\n\thooksPath = ${includedHooks}\n`);
    git(repo, 'config', 'include.path', included);

    const prepared = await prepareWorkspace(acpWorkspacePaths(tempDir(), JOB), repo);

    expect(readdirSync(markers)).toEqual([]);
    expect(readFileSync(join(prepared.workspace, 'a.txt'), 'utf-8')).toBe('content\n');
    expect(readFileSync(join(prepared.workspace, 'dir', 'b.txt'), 'utf-8')).toBe('nested\n');
  });

  it("a failed populate removes only its own worktree and leaves the user's other worktrees registered", async () => {
    const repo = tempDir();
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'test');
    writeFileSync(join(repo, 'a.txt'), 'content\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    // The user's own worktree, whose directory is temporarily missing.
    const otherHome = tempDir();
    const other = join(otherHome, 'other');
    git(repo, 'worktree', 'add', '--detach', '-q', other);
    const moved = join(otherHome, 'moved');
    renameSync(other, moved);
    const adminDir = join(repo, '.git', 'worktrees');
    const before = readdirSync(adminDir);
    expect(before).toEqual(['other']);

    const failing: CommandRunner = (cmd, args, options) =>
      args.includes('checkout-index')
        ? Promise.resolve({ code: 1, stdout: '', stderr: 'injected checkout-index failure' })
        : spawnCapture(cmd, args, options);
    const ethosHome = tempDir();
    const paths = acpWorkspacePaths(ethosHome, JOB);
    await expect(prepareWorkspace(paths, repo, failing)).rejects.toThrow(
      /populating the worktree failed/,
    );

    // The user's entry survives; this run's own is gone.
    expect(readdirSync(adminDir)).toEqual(['other']);
    expect(existsSync(paths.workspace)).toBe(false);
    expect(readdirSync(paths.root).filter((n) => n.startsWith('.populate-'))).toEqual([]);
  });

  it("a normal repo's working tree is byte-identical to a plain checkout", async () => {
    const repo = tempDir();
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'test');
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    writeFileSync(join(repo, 'src', 'deep', 'a.txt'), 'line one\r\nline two\n');
    writeFileSync(join(repo, 'src', 'bin.dat'), Buffer.from([0, 1, 2, 255, 254, 0]));
    writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(join(repo, 'run.sh'), 0o755);
    symlinkSync('src/deep/a.txt', join(repo, 'link'));
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');

    const prepared = await prepareWorkspace(acpWorkspacePaths(tempDir(), JOB), repo);
    const plain = join(tempDir(), 'plain');
    git(repo, 'worktree', 'add', '--detach', '-q', plain);

    expect(snapshot(prepared.workspace)).toEqual(snapshot(plain));
    expect(snapshot(prepared.workspace).some((e) => e.startsWith('x run.sh '))).toBe(true);
    expect(snapshot(prepared.workspace)).toContain('l link -> src/deep/a.txt');
    // The workspace is registered consistently with HEAD, not merely populated.
    expect(git(prepared.workspace, 'status', '--porcelain')).toBe('');
  });
});

/** Run git in `cwd` with the developer's own config out of the picture. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
}

/** Every entry under `root` (except `.git`) as `<kind> <path>[ -> target | #hash]`. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      if (rel === '' && name === '.git') continue;
      const path = rel === '' ? name : `${rel}/${name}`;
      const st = lstatSync(join(root, path));
      if (st.isSymbolicLink()) out.push(`l ${path} -> ${readlinkSync(join(root, path))}`);
      else if (st.isDirectory()) {
        out.push(`d ${path}`);
        walk(path);
      } else {
        const bytes = readFileSync(join(root, path)).toString('base64');
        out.push(`${st.mode & 0o111 ? 'x' : 'f'} ${path} #${bytes}`);
      }
    }
  };
  walk('');
  return out;
}
