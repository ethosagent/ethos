// Mechanical CI gate: ethos consumer code must use typed observability
// helpers (via wiring's `EthosObservability` adapter), not the raw
// `ObservabilityWriter.recordEvent` API. Only the wrapper itself is allowed
// to call writer.recordEvent.
//
// Failure means a new event was added through the raw API. Add a typed
// helper to EthosObservability or use the `recordEthosEvent` escape hatch.
//
// Implemented in pure Node so the test runs anywhere vitest does — no
// dependency on a separately-installed binary.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

const SCAN_ROOTS = [
  'packages/core/src',
  'packages/wiring/src',
  'extensions/gateway/src',
  'packages/safety/channel/src',
  'packages/safety/injection/src',
  'packages/safety/scanner/src',
  'packages/safety/watcher/src',
  'extensions/agent-mesh/src',
  'apps/ethos/src',
];

const WRAPPER_REL = 'packages/wiring/src/observability/ethos-observability.ts';

interface Hit {
  file: string;
  line: number;
  text: string;
}

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
      yield* walkSourceFiles(abs);
      continue;
    }
    if (!st.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    yield abs;
  }
}

function scan(pattern: RegExp, roots: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const root of roots) {
    const dir = join(REPO_ROOT, root);
    let exists = false;
    try {
      exists = statSync(dir).isDirectory();
    } catch {
      // Root missing — fine; nothing to scan.
    }
    if (!exists) continue;
    for (const file of walkSourceFiles(dir)) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i] ?? '';
        if (pattern.test(text)) {
          hits.push({ file: relative(REPO_ROOT, file), line: i + 1, text });
        }
      }
    }
  }
  return hits;
}

function format(hits: Hit[]): string {
  return hits.map((h) => `${h.file}:${h.line}: ${h.text.trim()}`).join('\n');
}

describe('observability call-site discipline', () => {
  it('no raw .recordEvent() calls in ethos consumer code', () => {
    const hits = scan(/\.recordEvent\(/, SCAN_ROOTS);
    const offenders = hits.filter((h) => h.file !== WRAPPER_REL);

    expect(
      offenders,
      `Use a typed EthosObservability helper instead of writer.recordEvent.\nOffenders:\n${format(
        offenders,
      )}`,
    ).toEqual([]);
  });

  it('no raw .startTrace() calls in ethos consumer code', () => {
    const hits = scan(/\.startTrace\(/, SCAN_ROOTS);
    const offenders = hits.filter((h) => h.file !== WRAPPER_REL);

    expect(
      offenders,
      `Use EthosObservability.startTurnTrace(...) etc.\nOffenders:\n${format(offenders)}`,
    ).toEqual([]);
  });
});
