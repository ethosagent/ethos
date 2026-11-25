import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every CLI command file either supports `--json` or is listed here with a
// reason. A stale name (file renamed or deleted) fails the "exists" tests, so
// the lists cannot silently rot.
const COMMANDS_DIR = join(__dirname, '..', 'commands');

const DOCTOR_SPLIT =
  'internal library of `ethos doctor`, split out of doctor.ts; --json is handled in doctor.ts';

const BOOT_SPLIT = 'internal library of `ethos boot`, split out of boot.ts; no CLI output';

const GATEWAY_SPLIT = 'internal library of `ethos gateway`, split out of gateway.ts; no CLI output';

const LISTEN_SPLIT =
  'internal library of `ethos listen`, split out of listen.ts; --json is handled in listen.ts';

const JSON_EXEMPT: Record<string, string> = {
  acp: 'long-running ACP server',
  boot: 'process bootstrap helper, no user output',
  'boot-constants': BOOT_SPLIT,
  'boot-context': BOOT_SPLIT,
  'boot-callcapture': BOOT_SPLIT,
  'boot-digest': BOOT_SPLIT,
  'boot-reload': BOOT_SPLIT,
  dashboard: 'launches the web UI (long-running)',
  gateway: 'start/setup are long-running; `status --json` lives in gateway-status.ts',
  'gateway-adapters': GATEWAY_SPLIT,
  'gateway-approval': GATEWAY_SPLIT,
  'gateway-bots': GATEWAY_SPLIT,
  'gateway-health': GATEWAY_SPLIT,
  'gateway-platform-readers': GATEWAY_SPLIT,
  'gateway-room-policy': GATEWAY_SPLIT,
  'gateway-whatsapp-link': GATEWAY_SPLIT,
  'gateway-voice': GATEWAY_SPLIT,
  'gateway-wiring': GATEWAY_SPLIT,
  'run-all': 'long-running multi-service launcher',
  serve: 'long-running HTTP server',
  setup: 'interactive wizard',
  zero: 'has its own `--format json`',
  'serve-a2a-runner': 'internal helper of serve (long-running)',
  'serve-acp': 'internal helper of serve, no CLI output',
  'serve-helpers': 'internal helper of serve, no CLI output',
  'serve-listen': 'internal helper of serve (long-running)',
  'serve-loop': 'internal helper of serve, no CLI output',
  'serve-util': 'internal helper of serve, no CLI output',
  'serve-web-api': 'internal helper of serve, no CLI output',
  _shared: 'constants shared by serve, gateway and boot, no CLI output',
  'cron-turn': 'internal cron turn runner, no CLI output',
  'cache-attribution': 'internal library, no CLI output',
  'doctor-decisions': DOCTOR_SPLIT,
  'doctor-reports': DOCTOR_SPLIT,
  'doctor-sdks': DOCTOR_SPLIT,
  'doctor-secrets': DOCTOR_SPLIT,
  'doctor-shared': DOCTOR_SPLIT,
  'doctor-skills': DOCTOR_SPLIT,
  'doctor-spool': DOCTOR_SPLIT,
  'doctor-storage': DOCTOR_SPLIT,
  'doctor-voice': DOCTOR_SPLIT,
  'listen-edge-stt': LISTEN_SPLIT,
  'listen-probes': LISTEN_SPLIT,
  'listen-preflight': LISTEN_SPLIT,
  'listen-routes': LISTEN_SPLIT,
  'listen-daemon': LISTEN_SPLIT,
  'listen-player': LISTEN_SPLIT,
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
