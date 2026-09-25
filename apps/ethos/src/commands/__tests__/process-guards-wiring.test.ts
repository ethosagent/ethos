// `ethos gateway start`, `ethos boot` and `ethos serve` each install the one
// process-guard helper (plan openclaw-2026.9.6-gaps R2). Before this only serve
// had handlers, inline; the two adapter-owning commands had none, so a single
// unhandled rejection killed every lane.
//
// Source text, the same idiom as `gateway-unattended-gate-wiring.test.ts`: the
// three commands boot whole processes and cannot be invoked from a unit test.
// The helper's behaviour is pinned by `__tests__/process-guards.test.ts`.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const read = (file: string) => readFile(join(ROOT, 'apps/ethos/src/commands', file), 'utf8');

describe('process guards wiring', () => {
  for (const file of ['gateway.ts', 'boot.ts']) {
    it(`${file} installs them with its bounded shutdown, once shutdown exists`, async () => {
      const src = await read(file);
      const signals = src.indexOf("process.on('SIGTERM', () => void shutdown());");
      const guards = src.indexOf('installProcessGuards({');
      expect(signals).toBeGreaterThan(-1);
      expect(guards).toBeGreaterThan(signals);
      expect(src.slice(guards, guards + 400)).toMatch(
        /shutdown: \(exitCode\) => shutdown\(exitCode\)/,
      );
    });
  }

  it('serve.ts uses the same helper and registers no handlers of its own', async () => {
    const src = await read('serve.ts');
    expect(src).toContain("installProcessGuards({ command: 'serve'");
    expect(src).not.toContain("process.on('unhandledRejection'");
    expect(src).not.toContain("process.on('uncaughtException'");
  });
});
