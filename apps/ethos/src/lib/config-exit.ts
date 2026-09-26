// The config-refusal exit shared by the two commands that own platform adapters
// (`ethos gateway start`, `ethos boot`) — plan openclaw-2026.9.6-gaps R3.
//
// A config that cannot be started from exits CONFIG_INVALID_EXIT_CODE (78), not
// 1: exit 1 reads to systemd and `Restart=on-failure` as "crashed, restart me",
// so a typo in config.yaml restarted every RestartSec forever. The gateway unit
// template names 78 in `RestartPreventExitStatus`.

import { CONFIG_INVALID_EXIT_CODE } from '@ethosagent/wiring';

const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/**
 * Print `heading` and each error, point at `ethos doctor`, and exit 78. A no-op
 * when `errors` is empty. `log`/`exit` are injectable for tests.
 */
export function exitIfConfigInvalid(
  heading: string,
  errors: readonly string[],
  deps: { log?: (line: string) => void; exit?: (code: number) => void } = {},
): void {
  if (errors.length === 0) return;
  const log = deps.log ?? ((line: string) => console.log(line));
  log(`${RED}${heading}:${RESET}`);
  for (const err of errors) log(`  • ${err}`);
  log('Run `ethos doctor` to see what is wrong and how to fix it.');
  (deps.exit ?? process.exit)(CONFIG_INVALID_EXIT_CODE);
}
