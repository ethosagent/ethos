#!/usr/bin/env node
// Size gate for source, test and doc files, with a shrink-only .size-baseline.json.
// Usage: node scripts/check-source-size.mjs [--root <dir>] [--prune] [--base <sha>] [--verbose]
//                                           [--write-initial]
//   (default)        fail on a file over its limit that the baseline does not list
//   --prune          rewrite the baseline: drop fixed or deleted entries, lower counts, never raise
//   --base [<sha>]   also fail when the baseline grew since <sha> and no commit carries the trailer
//                    `Size-Baseline-Approved-By: <name>` (same base fallback as
//                    scripts/check-archcheck-baseline.mjs: merge-base with origin/main, else HEAD~1)
//   --verbose        list baselined files that are over their limit
//   --write-initial  create the baseline from the current tree; refuses if it already exists
// Exit 0 clean, 1 on violations (stderr, one per line).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flagValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const rootGiven = args.includes('--root');
const root = flagValue('--root') ?? '.';
const verbose = args.includes('--verbose');

const BASELINE = '.size-baseline.json';
const TRAILER = 'Size-Baseline-Approved-By';
const SOURCE_WARN = 300;
const LIMITS = { source: 800, test: 500, doc: 200, readme: 120, skill: 300 };
const KINDS = Object.keys(LIMITS);
const EXEMPT = Object.freeze([
  'docs/content/changelog.md',
  'CHANGELOG.md',
  'docs/superpowers/plans/',
  'plan/',
  '.agents/skills/',
  'CLAUDE.md',
  'AGENTS.md',
  'ARCHITECTURE.md',
  'docs/decisions/',
]);
const WORKSPACE_ROOT = /^(packages\/safety\/[^/]+|packages\/[^/]+|extensions\/[^/]+|apps\/[^/]+)$/;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);

function git(cwd, gitArgs) {
  return execFileSync('git', gitArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tryGit(gitArgs) {
  try {
    return git(root, gitArgs).trim();
  } catch {
    // A ref git cannot resolve (no origin/main, a root commit's parent) is not an error here;
    // the caller falls through to the next candidate.
    return null;
  }
}

function walk(rel) {
  const out = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...walk(childRel));
    } else out.push(childRel);
  }
  return out;
}

function listFiles() {
  if (rootGiven) return walk('');
  return git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
}

function classify(path) {
  if (EXEMPT.some((e) => (e.endsWith('/') ? path.startsWith(e) : path === e))) return null;
  if (/(^|\/)(node_modules|dist)\//.test(path)) return null;
  if (path.endsWith('.md')) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (
      path.endsWith('/README.md') &&
      WORKSPACE_ROOT.test(dir) &&
      existsSync(join(root, dir, 'package.json'))
    ) {
      return 'readme';
    }
    if (/^skills\/(.*\/)?SKILL\.md$/.test(path)) return 'skill';
    return 'doc';
  }
  if (/\.(ts|tsx)$/.test(path) && !path.endsWith('.d.ts')) {
    return /\.test\.tsx?$/.test(path) || path.split('/').includes('__tests__') ? 'test' : 'source';
  }
  return null;
}

function lineCount(text) {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

function measure() {
  const out = [];
  for (const path of listFiles().sort()) {
    const kind = classify(path);
    // existsSync skips files deleted in the working tree but still listed by `git ls-files`.
    if (!kind || !existsSync(join(root, path))) continue;
    out.push({ path, kind, lines: lineCount(readFileSync(join(root, path), 'utf8')) });
  }
  return out;
}

// Baseline entries for `seed` paths whose file still exists and is over its limit, with
// lines = min(old ?? current, current), sorted by path. Used by --write-initial and --prune.
function rebuild(seed, byPath) {
  const entries = [];
  for (const { path, lines } of seed) {
    const f = byPath.get(path);
    if (!f || f.lines <= LIMITS[f.kind]) continue;
    entries.push({ path, kind: f.kind, lines: Math.min(lines ?? f.lines, f.lines) });
  }
  entries.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  writeFileSync(join(root, BASELINE), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
  return entries.length;
}

const readBaseline = () =>
  existsSync(join(root, BASELINE))
    ? (JSON.parse(readFileSync(join(root, BASELINE), 'utf8')).entries ?? [])
    : [];

// baselineAt, growth and checkBase mirror scripts/check-archcheck-baseline.mjs (a protected path,
// so not shared): keep the base resolution and trailer logic in sync with it.
function baselineAt(commit) {
  const source = tryGit(['show', `${commit}:${BASELINE}`]);
  if (source === null) return null;
  return new Map((JSON.parse(source).entries ?? []).map((e) => [e.path, e.lines]));
}

function growth(before, after) {
  const grown = [];
  for (const [path, lines] of after) {
    const was = before.get(path);
    if (was === undefined) grown.push(`new     ${path} (${lines})`);
    else if (lines > was) grown.push(`grew    ${path} (${was} -> ${lines})`);
  }
  return grown;
}

function checkBase() {
  const next = flagValue('--base');
  // A bare `--base` (no value, or another flag next) means: use the fallback base.
  const given = next?.startsWith('--') ? undefined : next;
  const base =
    given && !/^0+$/.test(given)
      ? given
      : (tryGit(['merge-base', 'HEAD', 'origin/main']) ?? tryGit(['rev-parse', 'HEAD~1']));
  if (!base) {
    console.log('source-size baseline: no base commit to compare against, skipping.');
    return 0;
  }
  const before = baselineAt(base);
  const after = baselineAt('HEAD');
  if (before === null || after === null) {
    console.log(
      `source-size baseline: no ${BASELINE} at ${before === null ? base : 'HEAD'}, nothing to compare.`,
    );
    return 0;
  }
  const net = growth(before, after);
  if (net.length === 0) {
    console.log(
      `source-size baseline: ${after.size} entries, nothing added or grown since ${base}.`,
    );
    return 0;
  }
  const commits =
    tryGit(['rev-list', '--reverse', `${base}..HEAD`, '--', BASELINE])
      ?.split('\n')
      .filter(Boolean) ?? [];
  const approvers = [];
  const unapproved = [];
  for (const commit of commits) {
    const was = baselineAt(`${commit}^`) ?? new Map();
    if (growth(was, baselineAt(commit) ?? new Map()).length === 0) continue;
    const approvedBy = git(root, [
      'log',
      '-1',
      `--format=%(trailers:key=${TRAILER},valueonly,separator=%x2C )`,
      commit,
    ]).trim();
    if (approvedBy) approvers.push(`${commit.slice(0, 10)} approved by ${approvedBy}`);
    else unapproved.push(commit.slice(0, 10));
  }
  if (unapproved.length === 0) {
    console.log(`source-size baseline grew since ${base}, with approval:`);
    for (const line of approvers) console.log(`  ${line}`);
    return 0;
  }
  console.error(`source-size baseline grew since ${base} without approval:`);
  for (const line of net) console.error(`  ${line}`);
  console.error(
    `commits that grew ${BASELINE} with no "${TRAILER}:" trailer: ${unapproved.join(', ')}`,
  );
  console.error(
    `  -> split the file instead of baselining it, or add "${TRAILER}: <name>" to that commit.`,
  );
  return 1;
}

function main() {
  const files = measure();
  const overLimit = (f) => f.lines > LIMITS[f.kind];
  const byPath = new Map(files.map((f) => [f.path, f]));

  if (args.includes('--write-initial')) {
    if (existsSync(join(root, BASELINE))) {
      console.error(`${BASELINE} already exists; --write-initial refuses to overwrite it.`);
      return 1;
    }
    console.log(`${BASELINE}: wrote ${rebuild(files, byPath)} entries.`);
    return 0;
  }

  if (args.includes('--prune')) {
    console.log(`${BASELINE}: ${rebuild(readBaseline(), byPath)} entries after prune.`);
    return 0;
  }

  const baselined = new Set(readBaseline().map((e) => e.path));
  const failures = [];
  const baselinedOver = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const listed = [];
  let warn = 0;
  for (const f of files) {
    if (f.kind === 'source' && f.lines > SOURCE_WARN) warn++;
    if (!overLimit(f)) continue;
    if (baselined.has(f.path)) {
      baselinedOver[f.kind]++;
      listed.push(`warn ${f.kind} ${f.path}: ${f.lines} lines > ${LIMITS[f.kind]} (baselined)`);
    } else {
      failures.push(
        `SIZE ${f.kind} ${f.path}: ${f.lines} lines > ${LIMITS[f.kind]} (not in ${BASELINE})`,
      );
    }
  }
  for (const line of failures) console.error(line);
  if (verbose) for (const line of listed) console.log(line);
  const split = KINDS.map((k) => baselinedOver[k]).join('+');
  console.log(
    `source-size: ${failures.length} failures; ${warn} warn>${SOURCE_WARN}; ${split} baselined (${KINDS.join('+')})`,
  );
  const sizeCode = failures.length === 0 ? 0 : 1;
  return args.includes('--base') ? Math.max(sizeCode, checkBase()) : sizeCode;
}

process.exit(main());
