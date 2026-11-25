// Lines of `config.yaml` that `ConfigRepository` does not model but must write
// back verbatim, split out of config.repository.ts: the `channels.*` block and
// any other `key: value` line the typed fields and passthrough cannot spell.

import { parseChannelsLine } from '@ethosagent/config';

export interface RoundTripLines {
  /**
   * `channels.*` lines `parseChannelsLine` (the grammar owner in
   * `@ethosagent/config`) claims, as ordered raw `[key, value]` pairs. Not
   * modelled: the key is as written (a selector may hold `*`, `@`, `:`) and the
   * value is the text after `key:` verbatim, so an invalid value survives an
   * unrelated save untouched. Pinned by
   * `__tests__/repositories/config-channels-roundtrip.test.ts`.
   */
  channelLines?: Array<[string, string]>;
  /**
   * Non-comment `key: value` lines nothing above could model (a key outside
   * `[\w.-]+`, an unknown `channels.*` field), kept verbatim and written back
   * after the passthrough block. The CLI parser warns about such a line; a web
   * save must not delete it.
   */
  rawLines?: string[];
}

export function emptyRoundTripLines(): Required<RoundTripLines> {
  return { channelLines: [], rawLines: [] };
}

/** `channels.*` — the config package's own line parser decides, before the
 *  generic key regex, which cannot spell a `*`, `@` or `:` selector. */
export function captureChannelLine(config: RoundTripLines, line: string): boolean {
  const channel = parseChannelsLine(line);
  if (!channel) return false;
  const key = line.slice(0, line.length - channel.value.length).replace(/:\s*$/, '');
  config.channelLines?.push([key, channel.value]);
  return true;
}

export function captureRawLine(config: RoundTripLines, line: string): void {
  const t = line.trim();
  if (t && !t.startsWith('#') && t.includes(':')) config.rawLines?.push(line);
}

/** `channels.*` pairs in file order, value as written. */
export function channelLineOutput(config: RoundTripLines): string[] {
  return (config.channelLines ?? []).map(([key, value]) => `${key}: ${value}`);
}
