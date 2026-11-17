import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts', 'check-source-size.mjs');
const dirs: string[] = [];

function lines(n: number): string {
  return `${Array.from({ length: n }, () => 'x').join('\n')}\n`;
}

function write(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'source-size-'));
  dirs.push(dir);
  write(dir, files);
  return dir;
}

function run(dir: string, ...extra: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', dir, ...extra], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

function git(dir: string, ...args: string[]) {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, stdio: 'ignore' },
  );
}

type Entry = { path: string; kind: string; lines: number };

function commit(dir: string, message: string) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

function baseline(entries: Entry[]): string {
  return `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;
}

const readBaseline = (dir: string) =>
  JSON.parse(readFileSync(join(dir, '.size-baseline.json'), 'utf8')) as {
    entries: Entry[];
  };

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const head = (dir: string) =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

// big.ts at 950 lines against a baseline of 900.
const grownFiles = () => ({
  'src/big.ts': lines(950),
  '.size-baseline.json': baseline([{ path: 'src/big.ts', kind: 'source', lines: 900 }]),
});
const grownFixture = () => fixture(grownFiles());

// A git repo whose first commit ("base") holds `files`, plus an optional unrelated commit.
function repoWithBase(
  files: Record<string, string>,
  opts: { unrelated?: boolean } = {},
): { dir: string; base: string } {
  const dir = fixture(files);
  git(dir, 'init', '-q');
  commit(dir, 'base');
  const base = head(dir);
  if (opts.unrelated) {
    write(dir, { 'src/other.ts': lines(10) });
    commit(dir, 'unrelated');
  }
  return { dir, base };
}

function baseRepo(): { dir: string; base: string } {
  return repoWithBase({
    'src/old.ts': lines(900),
    '.size-baseline.json': baseline([{ path: 'src/old.ts', kind: 'source', lines: 900 }]),
  });
}

function growOld(dir: string, message: string) {
  write(dir, {
    'src/old.ts': lines(950),
    '.size-baseline.json': baseline([{ path: 'src/old.ts', kind: 'source', lines: 950 }]),
  });
  commit(dir, message);
}

describe('check-source-size', () => {
  it('new 801-line source fails', () => {
    const r = run(fixture({ 'src/big.ts': lines(801) }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SIZE source');
    expect(r.stderr).toContain('src/big.ts');
  });

  it('new 801-line source in baseline warns', () => {
    const dir = fixture({
      'src/big.ts': lines(801),
      '.size-baseline.json': baseline([{ path: 'src/big.ts', kind: 'source', lines: 801 }]),
    });
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('0 failures');
  });

  it('new 501-line test fails', () => {
    const r = run(fixture({ 'src/__tests__/a.test.ts': lines(501) }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SIZE test');
  });

  it('201-line doc fails; changelog exempt passes', () => {
    const fail = run(fixture({ 'docs/guide.md': lines(201) }));
    expect(fail.status).toBe(1);
    expect(fail.stderr).toContain('SIZE doc');
    const pass = run(
      fixture({ 'docs/content/changelog.md': lines(201), 'CHANGELOG.md': lines(201) }),
    );
    expect(pass.status).toBe(0);
  });

  it('121-line package README fails', () => {
    const r = run(
      fixture({ 'packages/foo/package.json': '{}', 'packages/foo/README.md': lines(121) }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SIZE readme');
    // Without a package.json the same README is an ordinary doc, under 200.
    expect(run(fixture({ 'packages/foo/README.md': lines(121) })).status).toBe(0);
  });

  it('prune drops fixed entries and lowers counts, never raises', () => {
    const dir = fixture({
      'src/fixed.ts': lines(800),
      'src/shrunk.ts': lines(850),
      'src/grown.ts': lines(900),
      '.size-baseline.json': baseline([
        { path: 'src/fixed.ts', kind: 'source', lines: 900 },
        { path: 'src/gone.ts', kind: 'source', lines: 900 },
        { path: 'src/grown.ts', kind: 'source', lines: 810 },
        { path: 'src/shrunk.ts', kind: 'source', lines: 1000 },
      ]),
    });
    expect(run(dir, '--prune').status).toBe(0);
    expect(readBaseline(dir).entries).toEqual([
      { path: 'src/grown.ts', kind: 'source', lines: 810 },
      { path: 'src/shrunk.ts', kind: 'source', lines: 850 },
    ]);
  });

  it('--base fails on added entry without trailer; passes with Size-Baseline-Approved-By', () => {
    const { dir, base } = baseRepo();

    write(dir, {
      'src/new.ts': lines(900),
      '.size-baseline.json': baseline([
        { path: 'src/new.ts', kind: 'source', lines: 900 },
        { path: 'src/old.ts', kind: 'source', lines: 900 },
      ]),
    });
    commit(dir, 'grow baseline');
    const bad = run(dir, '--base', base);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('src/new.ts');

    git(dir, 'commit', '-q', '--amend', '-m', 'grow baseline\n\nSize-Baseline-Approved-By: Mitesh');
    const ok = run(dir, '--base', base);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('Mitesh');
  });

  it('--base: a trailer quoted in the body, not in the trailer block, is not approval', () => {
    const { dir, base } = baseRepo();
    growOld(
      dir,
      'grow\n\nSize-Baseline-Approved-By: Mallory\n\nMore prose follows the quoted line.',
    );
    const r = run(dir, '--base', base);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('grew');
  });

  it('--base: a raised lines value fails without trailer, passes with it', () => {
    const { dir, base } = baseRepo();
    growOld(dir, 'grow');
    const bad = run(dir, '--base', base);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('grew');
    git(dir, 'commit', '-q', '--amend', '-m', 'grow\n\nSize-Baseline-Approved-By: Mitesh');
    expect(run(dir, '--base', base).status).toBe(0);
  });

  it('bare --base falls back to HEAD~1', () => {
    const { dir } = baseRepo();
    growOld(dir, 'grow');
    const bad = run(dir, '--base');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('grew');
    expect(run(dir, '--base', '--verbose').status).toBe(1);
  });

  it('baselined file grown past its baseline fails, naming baseline and current counts', () => {
    const dir = grownFixture();
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('GROWN source src/big.ts: 950 lines > baseline 900');
    expect(r.stderr).toContain('split it or shrink it');
    const verbose = run(dir, '--verbose');
    expect(verbose.status).toBe(1);
    expect(verbose.stderr).toContain('GROWN source src/big.ts');
  });

  it.each([900, 850])('baselined file at %i lines (baseline 900) passes', (n) => {
    const dir = fixture({
      'src/big.ts': lines(n),
      '.size-baseline.json': baseline([{ path: 'src/big.ts', kind: 'source', lines: 900 }]),
    });
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('unbaselined file over its limit still fails alongside a baselined one', () => {
    const dir = fixture({
      'src/big.ts': lines(900),
      'src/new.ts': lines(801),
      '.size-baseline.json': baseline([{ path: 'src/big.ts', kind: 'source', lines: 900 }]),
    });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SIZE source src/new.ts');
    expect(r.stderr).not.toContain('src/big.ts');
  });

  it('grandfathers a count already over baseline at the base; only growth since fails', () => {
    const { dir, base } = repoWithBase(grownFiles(), { unrelated: true });
    // Default mode falls back to HEAD~1 (no origin/main here); --base takes an explicit sha.
    expect(run(dir).status).toBe(0);
    expect(run(dir, '--base', base).status).toBe(0);

    write(dir, { 'src/big.ts': lines(960) });
    const local = run(dir);
    expect(local.status).toBe(1);
    expect(local.stderr).toContain('960 lines > baseline 900 (950 at ');
    commit(dir, 'grow');
    expect(run(dir, '--base', base).status).toBe(1);
  });

  it('an unreachable --base falls back like a zero sha, with one notice', () => {
    const { dir } = repoWithBase(grownFiles(), { unrelated: true });
    // A force-pushed `github.event.before` that was never fetched.
    const gone = 'deadbeef'.repeat(5);
    const r = run(dir, '--base', gone);
    expect(r.status).toBe(0);
    expect(r.stdout.split(`base ${gone} is unreachable`).length - 1).toBe(1);

    write(dir, { 'src/big.ts': lines(960) });
    const grown = run(dir, '--base', gone);
    expect(grown.status).toBe(1);
    expect(grown.stderr).toContain('960 lines > baseline 900 (950 at ');
  });

  it('a symbolic --base is reported as its commit sha, not a truncated ref name', () => {
    const { dir, base: sha } = repoWithBase(grownFiles());
    git(dir, 'branch', 'basebranch');
    write(dir, { 'src/big.ts': lines(960) });
    const r = run(dir, '--base', 'basebranch');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`(950 at ${sha.slice(0, 10)})`);
  });

  it('a baselined file absent at the base is held to its baseline', () => {
    const { dir } = repoWithBase({ 'src/other.ts': lines(10) });
    write(dir, {
      'src/big.ts': lines(950),
      '.size-baseline.json': baseline([{ path: 'src/big.ts', kind: 'source', lines: 900 }]),
    });
    commit(dir, 'add');
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('GROWN source src/big.ts: 950 lines > baseline 900');
  });

  it('--write-initial records over-limit files and refuses when the baseline exists', () => {
    const dir = fixture({ 'src/big.ts': lines(801), 'src/ok.ts': lines(10) });
    expect(run(dir, '--write-initial').status).toBe(0);
    expect(readBaseline(dir).entries).toEqual([{ path: 'src/big.ts', kind: 'source', lines: 801 }]);
    expect(run(dir, '--write-initial').status).toBe(1);
  });
});
