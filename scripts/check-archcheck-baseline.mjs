#!/usr/bin/env node
// The archcheck baseline only shrinks.
//
// .archcheck/baseline.json records pre-existing architecture debt: archcheck stays green on every
// finding it lists. Adding an entry, or raising an entry's `occurrences`, therefore silences a
// NEW violation — so it is refused unless each commit that grew the file carries the trailer
//
//     Architecture-Approved-By: <name>
//
// Shrinking needs no approval (`pnpm exec archcheck baseline --prune` is the only way the file
// gets smaller). Identities and counts come from archcheck's baseline format (src/baseline in the
// archcheck package): `{ version: 1, entries: [{ identity, ruleId, occurrences, ... }] }`, where a
// missing `occurrences` reads as 1.
//
// Usage: node scripts/check-archcheck-baseline.mjs [--base <commit>]
//   --base  what to compare HEAD against. CI passes the PR base SHA, or the pushed-before SHA on a
//           push. Without it: the merge-base with origin/main, else HEAD~1.
// No baseline at the base or at HEAD → nothing to compare, pass.

import { execFileSync } from 'node:child_process';

const PATH = '.archcheck/baseline.json';
const TRAILER = 'Architecture-Approved-By';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tryGit(args) {
  try {
    return git(args).trim();
  } catch {
    // A ref git cannot resolve (no origin/main, a root commit's parent) is not an error here —
    // the caller falls through to the next candidate.
    return null;
  }
}

/** The baseline at a commit, as Map<identity, {ruleId, occurrences}>, or null when absent. */
function baselineAt(commit) {
  const source = tryGit(['show', `${commit}:${PATH}`]);
  if (source === null) return null;
  const parsed = JSON.parse(source);
  return new Map(
    (parsed.entries ?? []).map((e) => [
      e.identity,
      { ruleId: e.ruleId, occurrences: e.occurrences ?? 1 },
    ]),
  );
}

/** Entries in `after` that are new, or whose count went up, relative to `before`. */
function growth(before, after) {
  const grown = [];
  for (const [identity, entry] of after) {
    const was = before?.get(identity);
    if (!was) grown.push(`new     ${entry.ruleId} ${identity} (${entry.occurrences})`);
    else if (entry.occurrences > was.occurrences) {
      grown.push(`grew    ${entry.ruleId} ${identity} (${was.occurrences} → ${entry.occurrences})`);
    }
  }
  return grown;
}

function resolveBase() {
  const flag = process.argv.indexOf('--base');
  const given = flag === -1 ? undefined : process.argv[flag + 1];
  if (given && !/^0+$/.test(given)) return given;
  return tryGit(['merge-base', 'HEAD', 'origin/main']) ?? tryGit(['rev-parse', 'HEAD~1']);
}

const base = resolveBase();
if (!base) {
  console.log('archcheck baseline: no base commit to compare against — skipping.');
  process.exit(0);
}

const before = baselineAt(base);
const after = baselineAt('HEAD');
if (before === null || after === null) {
  console.log(
    `archcheck baseline: no ${PATH} at ${before === null ? base : 'HEAD'} — nothing to compare.`,
  );
  process.exit(0);
}

const netGrowth = growth(before, after);
if (netGrowth.length === 0) {
  console.log(`archcheck baseline: ${after.size} entries, nothing added or grown since ${base}.`);
  process.exit(0);
}

// The net diff grew. Every commit in the range that grew the file must carry the trailer.
const commits = git(['rev-list', '--reverse', `${base}..HEAD`, '--', PATH])
  .split('\n')
  .filter(Boolean);
const unapproved = [];
const approvers = [];
for (const commit of commits) {
  if (growth(baselineAt(`${commit}^`), baselineAt(commit) ?? new Map()).length === 0) continue;
  const approvedBy = git([
    'log',
    '-1',
    `--format=%(trailers:key=${TRAILER},valueonly,separator=%x2C )`,
    commit,
  ]).trim();
  if (approvedBy) approvers.push(`${commit.slice(0, 10)} approved by ${approvedBy}`);
  else unapproved.push(commit.slice(0, 10));
}

if (unapproved.length === 0) {
  console.log(`archcheck baseline grew since ${base}, with approval:`);
  for (const line of approvers) console.log(`  ${line}`);
  process.exit(0);
}

console.error(`archcheck baseline grew since ${base} without approval:`);
for (const line of netGrowth) console.error(`  ${line}`);
console.error(`commits that grew ${PATH} with no "${TRAILER}:" trailer: ${unapproved.join(', ')}`);
console.error(
  '  → fix the new violation instead of baselining it, or add the trailer to that commit ' +
    `("${TRAILER}: <name>") after an architecture review.`,
);
process.exit(1);
