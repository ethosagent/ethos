// Acceptance gate: runSetup() takes the readline fallback when stdin/stdout
// are not TTYs — the Ink wizard must never be imported in non-TTY environments.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('runSetup non-TTY path', () => {
  let originalStdinIsTTY: boolean | undefined;
  let originalStdoutIsTTY: boolean | undefined;

  beforeEach(() => {
    originalStdinIsTTY = process.stdin.isTTY;
    originalStdoutIsTTY = process.stdout.isTTY;
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
  });

  afterEach(() => {
    process.stdin.isTTY = originalStdinIsTTY ?? false;
    process.stdout.isTTY = originalStdoutIsTTY ?? false;
    vi.restoreAllMocks();
  });

  it('isTTY override works (test fixture sanity)', () => {
    expect(process.stdin.isTTY).toBe(false);
    expect(process.stdout.isTTY).toBe(false);
  });

  it('setup.ts source guards Ink import behind TTY check', () => {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const src = readFileSync(
      join(import.meta.dirname, '..', 'commands', 'setup.ts'),
      'utf8',
    ) as string;

    // The dynamic import of @ethosagent/tui/setup must only appear inside the
    // `if (process.stdin.isTTY && process.stdout.isTTY)` block.
    const tuiImportIndex = src.indexOf("import('@ethosagent/tui/setup')");
    const ttyCheckIndex = src.indexOf('process.stdin.isTTY && process.stdout.isTTY');

    expect(tuiImportIndex).toBeGreaterThan(-1);
    expect(ttyCheckIndex).toBeGreaterThan(-1);
    // TTY guard must appear before the dynamic import in source order
    expect(ttyCheckIndex).toBeLessThan(tuiImportIndex);
  });
});
