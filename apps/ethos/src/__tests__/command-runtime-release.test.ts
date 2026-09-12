import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');
const COMMANDS = join(SRC, 'commands');

/**
 * Lifecycle audit G4 — every command that BUILDS an agent loop must release it.
 *
 * The long-running hosts own their own bounded shutdown (a signal handler, a
 * memoised teardown, host stores closed in order), so they are listed here
 * rather than calling the one-shot helper. Everything else goes through
 * `releaseCommandRuntime` — a source pin, because the alternative is an
 * eleventh command that quietly forgets and leaves a `-wal` file behind.
 */
const DAEMONS = new Set(['serve.ts', 'boot.ts', 'gateway.ts']);

const BUILDERS = /\b(createAgentLoop|resolveActiveLoop|createTeamAgentLoop)\(/;

function sourceFiles(): Array<{ name: string; src: string }> {
  const files = readdirSync(COMMANDS)
    .filter((f) => f.endsWith('.ts'))
    .map((name) => ({ name, src: readFileSync(join(COMMANDS, name), 'utf-8') }));
  files.push({ name: 'index.ts', src: readFileSync(join(SRC, 'index.ts'), 'utf-8') });
  return files;
}

describe('one-shot commands release the loop they built (G4)', () => {
  const builders = sourceFiles().filter(
    (f) => BUILDERS.test(f.src) && !DAEMONS.has(f.name) && !f.name.endsWith('.test.ts'),
  );

  it('finds the command files that build a loop', () => {
    // Guard against the regex silently matching nothing after a rename.
    expect(builders.map((f) => f.name).sort()).toEqual([
      'acp.ts',
      'batch.ts',
      'bench.ts',
      'chat.ts',
      'cron.ts',
      'eval.ts',
      'index.ts',
      'mcp.ts',
      'personality-evolve.ts',
      'zero.ts',
    ]);
  });

  for (const { name, src } of builders) {
    it(`${name} calls releaseCommandRuntime`, () => {
      expect(src).toMatch(/releaseCommandRuntime\(/);
    });
  }
});
