// B2 (plan ux-feedback-and-config-clarity §4) — config parse warnings in chat.
//
// The default `ethos` command prints each `configParseNotices` warning line
// (unknown keys with their line number and nearest-key suggestion, plus
// deprecations' warning half) once per process, yellow, before the welcome
// line. Once per process: a `/model` rebuild re-enters wiring with the same
// config and must not repeat them. Pinned by
// __tests__/chat-config-warnings.test.ts.

import { configParseNotices, type EthosConfig } from '@ethosagent/config';

let printedThisProcess = false;

/** The warning lines chat still owes this process — empty after the first call. */
export function configWarningLinesOnce(config: EthosConfig): string[] {
  if (printedThisProcess) return [];
  printedThisProcess = true;
  return configParseNotices(config).warnings;
}

/** Test seam — resets the once-per-process latch. */
export function resetConfigWarningsForTest(): void {
  printedThisProcess = false;
}
