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
  'mcp-presets-check': 'internal library of `mcp presets --check`; --json is handled in mcp.ts',
  'registry-table': 'internal table renderer, no CLI output',
  'supervisor-lifecycle': 'internal library of the supervisor, no CLI output',
  'team-runtime': 'internal library, no CLI output',
  'verbose-timing': 'internal library, no CLI output',
  'zero-stream': 'internal helper of zero (streams)',
  learn: 'prints chat-usage help only',
  'pairing-commands':
    'library of the chat REPL /allow /deny /communications slash commands; returns strings, no CLI output',
  'request-dump': 'internal debug dumper, no CLI output',
  'memory-file': 'already JSON-capable: index.ts passes `jsonMode` to runMemoryFileCommand',
};

const files = readdirSync(COMMANDS_DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => f.slice(0, -3));

describe('CLI --json census', () => {
  it('every JSON_EXEMPT name is an existing command file', () => {
    const stale = Object.keys(JSON_EXEMPT).filter((n) => !files.includes(n));
    expect(stale).toEqual([]);
  });

  it('every other command file supports --json', () => {
    const missing = files.filter(
      (name) =>
        !(name in JSON_EXEMPT) &&
        !readFileSync(join(COMMANDS_DIR, `${name}.ts`), 'utf-8').includes('--json'),
    );
    expect(missing).toEqual([]);
  });
});
