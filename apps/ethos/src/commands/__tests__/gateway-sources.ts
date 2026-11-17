// The source of `ethos gateway start`, for the wiring tests that assert against
// text (`runGatewayStart` is a long-running composition root and cannot run
// under vitest).
//
// `runGatewayStart` lives in commands/gateway.ts but the helpers it calls live
// in sibling modules (commands/gateway-*.ts). A test that reads gateway.ts
// alone silently narrows whenever a helper moves out: a "never X anywhere in
// the gateway" guard keeps passing while X appears in the moved code. So:
//   - whole-source guards (contains / not-contains / counts) read
//     `readGatewaySources()`, every gateway module at once;
//   - ordering guards (`indexOf` a < `indexOf` b) read `gatewayFileWith(a, b)`,
//     the ONE module holding every anchor. If an extraction splits a pair
//     across two modules this throws, instead of comparing offsets from two
//     different files and passing by accident.
//
// The list holds `runGatewayStart` and the modules split out of gateway.ts. It
// does NOT hold the commands that were already separate (gateway-status). A
// module split out of gateway.ts later must be appended here.

import { fileWith, readCommandSource, readSources } from './command-sources';

export const GATEWAY_SOURCE_FILES = [
  'gateway.ts',
  'gateway-bots.ts',
  'gateway-voice.ts',
  'gateway-health.ts',
  'gateway-approval.ts',
  'gateway-platform-readers.ts',
  'gateway-adapters.ts',
  'gateway-wiring.ts',
] as const;

export function readGatewaySource(file: (typeof GATEWAY_SOURCE_FILES)[number]): string {
  return readCommandSource(file);
}

/** Every gateway module, concatenated. For whole-source guards only. */
export function readGatewaySources(): string {
  return readSources(GATEWAY_SOURCE_FILES);
}

/** The single gateway module containing every anchor. Throws when none does, or
 *  when more than one does (an ambiguous anchor). */
export function gatewayFileWith(...anchors: string[]): string {
  return fileWith('gateway', GATEWAY_SOURCE_FILES, ...anchors);
}
