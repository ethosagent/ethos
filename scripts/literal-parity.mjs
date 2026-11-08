// node scripts/literal-parity.mjs <baseRef> [<dir>...] [--expect-zero]   (read-only; Node 24)
// Diffs the multiset of string literals (string, no-substitution template, template head/middle/tail
// text) per package between <baseRef> and the working tree. Comments are ignored. A pure-move
// refactor must print no diff. Exit 1 on any diff under --expect-zero; usage errors exit 2.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const args = process.argv.slice(2);
const expectZero = args.includes('--expect-zero');
const positional = args.filter((a) => !a.startsWith('--'));
const baseRef = positional[0];
if (!baseRef) {
  console.error('usage: node scripts/literal-parity.mjs <baseRef> [<dir>...] [--expect-zero]');
  process.exit(2);
}
const dirs = (positional.length > 1 ? positional.slice(1) : ['apps', 'packages', 'extensions']).map(
  (d) => d.replace(/\/+$/, ''),
);
const root = process.cwd();
const git = (a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });

const isSource = (f) =>
  /\.(ts|tsx)$/.test(f) &&
  /^(apps|packages|extensions)\//.test(f) &&
  dirs.some((d) => f === d || f.startsWith(`${d}/`)) &&
  !/(__tests__|\.test\.|\.spec\.|\/e2e\/|fixtures\/|\.d\.ts$)/.test(f);

// Package = first two path segments, three under packages/safety/.
const pkgOf = (f) => {
  const p = f.split('/');
  return p[0] === 'packages' && p[1] === 'safety'
    ? p.slice(0, 3).join('/')
    : p.slice(0, 2).join('/');
};

const baseFiles = git(['ls-tree', '-r', '--name-only', baseRef]).split('\n').filter(isSource);
const workFiles = git(['ls-files', '-co', '--exclude-standard'])
  .split('\n')
  .filter((f) => isSource(f) && existsSync(join(root, f)));

const collect = (text, file, into) => {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const add = (s) => into.set(s, (into.get(s) ?? 0) + 1);
  const visit = (n) => {
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      add(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
};

const base = new Map();
const work = new Map();
const bucket = (m, pkg) => {
  const existing = m.get(pkg);
  if (existing) return existing;
  const created = new Map();
  m.set(pkg, created);
  return created;
};
for (const f of baseFiles) {
  collect(git(['show', `${baseRef}:${f}`]), f, bucket(base, pkgOf(f)));
}
for (const f of workFiles) {
  collect(readFileSync(join(root, f), 'utf8'), f, bucket(work, pkgOf(f)));
}

let diffs = 0;
const pkgs = [...new Set([...base.keys(), ...work.keys()])].sort();
for (const pkg of pkgs) {
  const a = base.get(pkg) ?? new Map();
  const b = work.get(pkg) ?? new Map();
  const lines = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const d = (b.get(k) ?? 0) - (a.get(k) ?? 0);
    if (d !== 0) lines.push([k, d]);
  }
  if (lines.length === 0) continue;
  lines.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  diffs += lines.length;
  console.log(`${pkg}`);
  for (const [k, d] of lines) console.log(`  ${d > 0 ? '+' : ''}${d}  ${JSON.stringify(k)}`);
}
console.log(
  diffs === 0 ? 'literal-parity: zero diff' : `literal-parity: ${diffs} differing literal(s)`,
);
if (expectZero && diffs > 0) process.exit(1);
