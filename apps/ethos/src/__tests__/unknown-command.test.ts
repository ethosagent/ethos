import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

// Lifecycle audit G11 (pre-existing) — `apps/ethos/src/index.ts` dispatches at
// module top level, and the `default` branch reached `getBootCliRegistry()`
// before the `let _bootCliRegistry` below it was initialised. Every unknown
// command therefore printed `✗ INTERNAL: Cannot access '_bootCliRegistry'
// before initialization` instead of the usage text.
describe('an unknown command prints usage (G11)', () => {
  it('says "Unknown command" and exits 1', async () => {
    const result = await run(
      process.execPath,
      ['--import', 'tsx', join(ROOT, 'apps/ethos/src/index.ts'), 'definitely-not-a-command'],
      { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } },
    ).catch((err: { code?: number; stdout?: string; stderr?: string }) => err);
    const out = `${(result as { stdout?: string }).stdout ?? ''}${(result as { stderr?: string }).stderr ?? ''}`;
    expect(out).toContain('Unknown command: definitely-not-a-command');
    expect(out).not.toContain('_bootCliRegistry');
    expect((result as { code?: number }).code).toBe(1);
  }, 60_000);
});
