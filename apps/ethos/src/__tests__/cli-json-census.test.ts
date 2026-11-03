import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every CLI command file either supports `--json` or is listed here with a
// reason. A stale name (file renamed or deleted) fails the "exists" tests, so
// the lists cannot silently rot.
const COMMANDS_DIR = join(__dirname, '..', 'commands');

const JSON_EXEMPT: Record<string, string> = {
  acp: 'long-running ACP server',
  boot: 'process bootstrap helper, no user output',
  dashboard: 'launches the web UI (long-running)',
  gateway: 'start/setup are long-running; `status --json` lives in gateway-status.ts',
  'run-all': 'long-running multi-service launcher',
  serve: 'long-running HTTP server',
  setup: 'interactive wizard',
  zero: 'has its own `--format json`',
  'serve-a2a-runner': 'internal helper of serve (long-running)',
  'serve-helpers': 'internal helper of serve, no CLI output',
  'serve-listen': 'internal helper of serve (long-running)',
  'cron-turn': 'internal cron turn runner, no CLI output',
  'cache-attribution': 'internal library, no CLI output',
  'mcp-export': 'internal library, no CLI output',
  'mcp-preset-args': 'internal library, no CLI output',
  'registry-table': 'internal table renderer, no CLI output',
  'supervisor-lifecycle': 'internal library of the supervisor, no CLI output',
  'team-runtime': 'internal library, no CLI output',
  'verbose-timing': 'internal library, no CLI output',
  'zero-stream': 'internal helper of zero (streams)',
  learn: 'prints chat-usage help only',
  'request-dump': 'internal debug dumper, no CLI output',
  'memory-file': 'already JSON-capable: index.ts passes `jsonMode` to runMemoryFileCommand',
};

// Task 15-17 families, not yet converted. Each later task removes its names.
const PENDING = new Set([
  // Task 15: personality
  'personality-create',
  'personality-export',
  'personality-birth',
  'personality-evolve',
  // Task 16: learning & eval
  'learning',
  'evolve',
  'eval',
  'nightly',
  'digest',
  'outbox',
  // Task 17: ops & inspection
  'audit',
  'archive',
  'trace',
  'models',
  'fallback',
  'migrate-models',
  'commands',
  'claw',
  'batch',
  'bench',
  'set',
  'slack-manifest',
  'systemd-unit',
  'pairing-commands',
  'setup-from-env',
]);

const files = readdirSync(COMMANDS_DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => f.slice(0, -3));

describe('CLI --json census', () => {
  it('every JSON_EXEMPT and PENDING name is an existing command file', () => {
    const stale = [...Object.keys(JSON_EXEMPT), ...PENDING].filter((n) => !files.includes(n));
    expect(stale).toEqual([]);
  });

  it('no file is both exempt and pending', () => {
    expect([...PENDING].filter((n) => n in JSON_EXEMPT)).toEqual([]);
  });

  it('every other command file supports --json', () => {
    const missing = files.filter(
      (name) =>
        !(name in JSON_EXEMPT) &&
        !PENDING.has(name) &&
        !readFileSync(join(COMMANDS_DIR, `${name}.ts`), 'utf-8').includes('--json'),
    );
    expect(missing).toEqual([]);
  });

  it('a PENDING file that already supports --json must leave PENDING', () => {
    const done = [...PENDING].filter((name) =>
      readFileSync(join(COMMANDS_DIR, `${name}.ts`), 'utf-8').includes('--json'),
    );
    expect(done).toEqual([]);
  });
});
