// Mechanical CI gate: the library may only depend on `@ethosagent/types`
// and `@ethosagent/safety-redact` (zero-dep safety primitives) from the
// workspace. Any other `@ethosagent/*` import would couple it to
// ethos-specific code and break the extractability promise.
//
// Implemented in pure Node so the test runs anywhere vitest does — no
// dependency on a separately-installed binary.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const LIB_ROOT = join(REPO_ROOT, 'extensions', 'observability-sqlite', 'src');

const ALLOWED_WORKSPACE = new Set(['@ethosagent/types', '@ethosagent/safety-redact']);
const WORKSPACE_RE = /from\s+['"](@ethosagent\/[^'"\s]+)['"]/g;

function* walkLibrarySources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      yield* walkLibrarySources(abs);
      continue;
    }
    if (st.isFile() && /\.(ts|tsx)$/.test(entry)) yield abs;
  }
}

interface ForbiddenImport {
  file: string;
  line: number;
  packageName: string;
  text: string;
}

describe('observability-sqlite import graph', () => {
  it('library source only imports allowed zero-dep workspace packages', () => {
    const offenders: ForbiddenImport[] = [];
    for (const file of walkLibrarySources(LIB_ROOT)) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i] ?? '';
        for (const match of text.matchAll(WORKSPACE_RE)) {
          const pkg = match[1];
          if (pkg && !ALLOWED_WORKSPACE.has(pkg)) {
            offenders.push({
              file: relative(REPO_ROOT, file),
              line: i + 1,
              packageName: pkg,
              text: text.trim(),
            });
          }
        }
      }
    }

    expect(
      offenders,
      `Library source must not depend on workspace packages other than ${[...ALLOWED_WORKSPACE].join(', ')}.\nOffenders:\n${offenders
        .map((o) => `${o.file}:${o.line}: imports ${o.packageName}`)
        .join('\n')}`,
    ).toEqual([]);
  });
});
