// Source-file listing and classification shared by check-source-size.mjs and
// report-function-length.mjs. `classify` is the definition of the size-gate file kinds.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const EXEMPT = Object.freeze([
  'docs/content/changelog.md',
  'CHANGELOG.md',
  'plan/',
  '.agents/skills/',
  'CLAUDE.md',
  'AGENTS.md',
  'ARCHITECTURE.md',
  'docs/decisions/',
]);
// The plan's four workspace roots: a deliberate subset of pnpm-workspace.yaml (plugins/*,
// examples/* and docs are not gated). A workspace dir is a direct child of one of them.
export const WORKSPACE_ROOTS = Object.freeze(['packages', 'packages/safety', 'extensions', 'apps']);
const isWorkspaceDir = (dir) => WORKSPACE_ROOTS.includes(dir.slice(0, dir.lastIndexOf('/')));
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);

function walk(root, rel) {
  const out = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...walk(root, childRel));
    } else out.push(childRel);
  }
  return out;
}

export function listFiles(root, rootGiven) {
  if (rootGiven) return walk(root, '');
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

export function classify(root, path) {
  if (EXEMPT.some((e) => (e.endsWith('/') ? path.startsWith(e) : path === e))) return null;
  if (/(^|\/)(node_modules|dist)\//.test(path)) return null;
  if (path.endsWith('.md')) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (
      path.endsWith('/README.md') &&
      isWorkspaceDir(dir) &&
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

export function lineCount(text) {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}
