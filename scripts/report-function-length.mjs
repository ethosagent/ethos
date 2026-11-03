#!/usr/bin/env node
// Report-only function-length measurement over the tracked `source` set. Never gates anything.
// Usage: node scripts/report-function-length.mjs [--root <dir>] [--min 50] [--json]
//   --root <dir>  walk <dir> (skipping .git, node_modules, dist) instead of `git ls-files`
//   --min <n>     list functions whose body spans MORE than n lines (default 50)
//   --json        print { total, over50, over100, over200, byFile, functions } instead of text
// Length definition: the BODY span, inclusive of both ends. For a block body that is the line of
// `{` through the line of `}` (a 51-line function including its braces has length 51). For an
// expression-bodied arrow it is the first through last line of the expression. The signature
// before the body is not counted. Nodes without a body (overloads, abstract, declare) are skipped.
// `total` counts every measured function; over50/over100/over200 use fixed strict thresholds
// (> 50, > 100, > 200) regardless of --min; `functions` and `byFile` cover only functions over --min.
// Exit 0 always, except 2 on bad CLI usage.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import { classify, listFiles } from './lib/source-files.mjs';

const usage = (msg) => {
  console.error(`${msg}\nUsage: report-function-length.mjs [--root <dir>] [--min 50] [--json]`);
  process.exit(2);
};
let values;
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2),
    options: { root: { type: 'string' }, min: { type: 'string' }, json: { type: 'boolean' } },
    strict: true,
    allowPositionals: false,
  }));
} catch (err) {
  usage(err.message);
}
const rootGiven = values.root !== undefined;
const root = values.root ?? '.';
const asJson = values.json === true;
const minRaw = values.min ?? '50';
if (!/^\d+$/.test(minRaw)) usage(`--min must be a non-negative integer, got: ${minRaw}`);
const min = Number(minRaw);

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

const nameText = (n) => (n && !ts.isComputedPropertyName(n) ? n.getText() : undefined);

function functionName(node) {
  if (node.kind === ts.SyntaxKind.Constructor) return qualify(node, 'constructor');
  if (node.name) {
    const own = nameText(node.name) ?? '<computed>';
    return ts.isFunctionDeclaration(node) ? own : qualify(node, own);
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const p = node.parent;
    if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) {
      const own = nameText(p.name);
      if (own) return ts.isVariableDeclaration(p) ? own : qualify(p, own);
    }
  }
  return '<anonymous>';
}

// Prefix `Class.` when the member lives in a named class.
function qualify(member, own) {
  const cls = member.parent;
  if ((ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) && cls.name) {
    return `${cls.name.text}.${own}`;
  }
  return own;
}

// Reported line: the function's own start, not a decorator above it. With decorators we use the
// name (or the body for anonymous nodes); otherwise the node start (which includes modifiers).
function startPos(node, sf) {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  return decorators?.length ? (node.name ?? node.body).getStart(sf) : node.getStart(sf);
}

function measureFile(path, text) {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const out = [];
  const visit = (node) => {
    if (FUNCTION_KINDS.has(node.kind) && node.body) {
      const start = sf.getLineAndCharacterOfPosition(node.body.getStart(sf)).line;
      const end = sf.getLineAndCharacterOfPosition(node.body.end).line;
      out.push({
        path,
        line: sf.getLineAndCharacterOfPosition(startPos(node, sf)).line + 1,
        name: functionName(node),
        lines: end - start + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const all = [];
for (const path of listFiles(root, rootGiven).sort()) {
  // existsSync skips files deleted in the working tree but still listed by `git ls-files`.
  if (classify(root, path) !== 'source' || !existsSync(join(root, path))) continue;
  all.push(...measureFile(path, readFileSync(join(root, path), 'utf8')));
}

const over = (n) => all.filter((f) => f.lines > n);
const listed = all
  .filter((f) => f.lines > min)
  .sort(
    (a, b) => b.lines - a.lines || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line),
  );
const byFileMap = new Map();
for (const f of listed) {
  const e = byFileMap.get(f.path) ?? { path: f.path, count: 0, max: 0 };
  e.count++;
  e.max = Math.max(e.max, f.lines);
  byFileMap.set(f.path, e);
}
const byFile = [...byFileMap.values()].sort((a, b) => b.count - a.count || b.max - a.max);
const o50 = over(50);
const [n50, n100, n200] = [o50.length, over(100).length, over(200).length];

if (asJson) {
  const report = {
    total: all.length,
    over50: n50,
    over100: n100,
    over200: n200,
    byFile,
    functions: listed,
  };
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const f of listed) console.log(`${f.lines}\t${f.path}:${f.line}\t${f.name}`);
  const files50 = new Set(o50.map((f) => f.path)).size;
  console.log(`functions>50: ${n50} in ${files50} files; >100: ${n100}; >200: ${n200}`);
}
