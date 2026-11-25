import type { ModelTierName } from '@ethosagent/types';
import { parseConfigScalar } from '../scalar';

/** One `channels.<platform>.<selector>` entry, before the gateway resolves it. */
export interface RawRoomEntry {
  prompt?: string;
  skills?: string[];
  /** Model-registry alias. Mutually exclusive with `tier`. */
  model?: string;
  tier?: ModelTierName;
  identity?: boolean;
  metadata?: boolean;
  inherit?: boolean;
  /** NO_REPLY sends nothing in this room (plan L11, D20). */
  silent?: boolean;
  /** Default reply mode token; per-platform enum validation happens at the gateway/app (plan L12). */
  mode?: string;
}

/**
 * `EthosConfig.channels` value (plan channel-prompts §3.2): from
 * `channels.<platform>.<selector>.<field>` and the two platform knobs. Read
 * ONCE when the gateway is built; `config-reload.ts` reports a change as
 * restart-required (`UNSUPPORTED_KEYS`).
 */
export interface ChannelsPlatformConfig {
  /** selector → entry. Null-prototype: `__proto__` is a legal selector. */
  entries: Record<string, RawRoomEntry>;
  allowNameMatching?: boolean;
  fetchMetadata?: boolean;
}

const KNOB_FIELDS = ['allow_name_matching', 'fetch_metadata'] as const;
const ENTRY_FIELDS = [
  'prompt',
  'skills',
  'model',
  'tier',
  'identity',
  'metadata',
  'inherit',
  'silent',
  'mode',
] as const;

type KnobField = (typeof KNOB_FIELDS)[number];
type EntryField = (typeof ENTRY_FIELDS)[number];

/** One parsed `channels.*` line. A knob has no selector. */
export type ChannelsLine =
  | { kind: 'knob'; platform: string; field: KnobField; value: string }
  | { kind: 'entry'; platform: string; selector: string; field: EntryField; value: string };

const PLATFORM = '([a-z0-9_-]+)';
// Both regexes are built from the field lists above, so a new field is one edit.
const KNOB_RE = new RegExp(`^channels\\.${PLATFORM}\\.(${KNOB_FIELDS.join('|')}):\\s*(.*)$`);
// The selector may contain dots and `@`; the lazy match anchors on the first
// `.<field>:`, so a value that itself contains `.skills:` cannot re-route the key.
const ENTRY_RE = new RegExp(
  `^channels\\.${PLATFORM}\\.(.+?)\\.(${ENTRY_FIELDS.join('|')}):\\s*(.*)$`,
);

const isKnob = (f: string): f is KnobField => KNOB_FIELDS.some((k) => k === f);
const isEntryField = (f: string): f is EntryField => ENTRY_FIELDS.some((k) => k === f);

/** Parse one raw `channels.…: value` line; null when it is neither a knob nor an entry field. */
export function parseChannelsLine(line: string): ChannelsLine | null {
  const knob = line.match(KNOB_RE);
  if (knob && isKnob(knob[2]))
    return { kind: 'knob', platform: knob[1], field: knob[2], value: knob[3] };
  const ent = knob ? null : line.match(ENTRY_RE);
  if (ent && isEntryField(ent[3])) {
    return { kind: 'entry', platform: ent[1], selector: ent[2], field: ent[3], value: ent[4] };
  }
  return null;
}

const TIERS = [
  'trivial',
  'default',
  'deep',
  'dreaming',
] as const satisfies readonly ModelTierName[];
// Compile-time: adding a tier to ModelTierName fails here until TIERS lists it.
const _tiersExhaustive: [Exclude<ModelTierName, (typeof TIERS)[number]>] extends [never]
  ? true
  : never = true;
void _tiersExhaustive;

/** A reply-mode token such as `mention_only`; the per-platform enum is checked downstream. */
const MODE_TOKEN = /^[a-z_]+$/;

const tierName = (v: string): ModelTierName | undefined => TIERS.find((t) => t === v);

function parseBool(v: string): boolean | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/**
 * Build `EthosConfig.channels` from the lines the parser collected, in file
 * order (the later of two lines for one key wins). Bad values warn and are
 * dropped — never throw, so a typo cannot stop boot. Every map is
 * `Object.create(null)` so a `__proto__` selector or platform is an ordinary
 * key. Pinned by `__tests__/config-channels.test.ts`.
 */
export function buildChannels(
  lines: readonly ChannelsLine[],
  warnings: string[],
): Record<string, ChannelsPlatformConfig> | undefined {
  const result: Record<string, ChannelsPlatformConfig> = Object.create(null);
  const platformOf = (p: string): ChannelsPlatformConfig => {
    let cfg = result[p];
    if (!cfg) {
      cfg = { entries: Object.create(null) };
      result[p] = cfg;
    }
    return cfg;
  };

  for (const line of lines) {
    const raw = line.value;
    if (line.kind === 'knob') {
      const full = `channels.${line.platform}.${line.field}`;
      const b = parseBool(raw);
      if (b === undefined) {
        warnings.push(`${full}: '${raw}' is not true or false — ignored.`);
        continue;
      }
      platformOf(line.platform)[
        line.field === 'allow_name_matching' ? 'allowNameMatching' : 'fetchMetadata'
      ] = b;
      continue;
    }
    const full = `channels.${line.platform}.${line.selector}.${line.field}`;
    const cfg = platformOf(line.platform);
    let entry = cfg.entries[line.selector];
    if (!entry) {
      entry = {};
      cfg.entries[line.selector] = entry;
    }
    switch (line.field) {
      case 'prompt':
        if (raw !== '') entry.prompt = raw;
        break;
      case 'skills': {
        const skills = [
          ...new Set(
            raw
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s !== ''),
          ),
        ];
        if (skills.length > 0) entry.skills = skills;
        break;
      }
      case 'model':
        if (raw !== '') entry.model = raw;
        break;
      case 'mode':
        if (MODE_TOKEN.test(raw)) entry.mode = raw;
        else warnings.push(`${full}: '${raw}' is not a mode token ([a-z_]+) — ignored.`);
        break;
      case 'tier': {
        const t = tierName(raw);
        if (t) entry.tier = t;
        else warnings.push(`${full}: '${raw}' is not a tier (${TIERS.join(', ')}) — ignored.`);
        break;
      }
      case 'identity':
      case 'metadata':
      case 'inherit':
      case 'silent': {
        const b = parseBool(raw);
        if (b === undefined) warnings.push(`${full}: '${raw}' is not true or false — ignored.`);
        else entry[line.field] = b;
        break;
      }
    }
  }

  for (const [platform, cfg] of Object.entries(result)) {
    for (const [selector, entry] of Object.entries(cfg.entries)) {
      if (entry.model !== undefined && entry.tier !== undefined) {
        warnings.push(
          `channels.${platform}.${selector}: model and tier are mutually exclusive — keeping model, ignoring tier.`,
        );
        delete entry.tier;
      }
      if (Object.keys(entry).length === 0) delete cfg.entries[selector];
    }
    if (
      Object.keys(cfg.entries).length === 0 &&
      cfg.allowNameMatching === undefined &&
      cfg.fetchMetadata === undefined
    ) {
      delete result[platform];
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Serializer lines for `EthosConfig.channels` (round-trips through the parser). */
export function channelsToLines(channels: Record<string, ChannelsPlatformConfig>): string[] {
  const lines: string[] = [];
  for (const [platform, cfg] of Object.entries(channels)) {
    if (cfg.allowNameMatching !== undefined)
      lines.push(`channels.${platform}.allow_name_matching: ${cfg.allowNameMatching}`);
    if (cfg.fetchMetadata !== undefined)
      lines.push(`channels.${platform}.fetch_metadata: ${cfg.fetchMetadata}`);
    for (const [selector, e] of Object.entries(cfg.entries)) {
      const p = `channels.${platform}.${selector}`;
      if (e.prompt !== undefined) lines.push(`${p}.prompt: ${e.prompt}`);
      if (e.skills && e.skills.length > 0) lines.push(`${p}.skills: ${e.skills.join(',')}`);
      if (e.model !== undefined) lines.push(`${p}.model: ${e.model}`);
      if (e.tier !== undefined) lines.push(`${p}.tier: ${e.tier}`);
      if (e.identity !== undefined) lines.push(`${p}.identity: ${e.identity}`);
      if (e.metadata !== undefined) lines.push(`${p}.metadata: ${e.metadata}`);
      if (e.inherit !== undefined) lines.push(`${p}.inherit: ${e.inherit}`);
      if (e.silent !== undefined) lines.push(`${p}.silent: ${e.silent}`);
      if (e.mode !== undefined) lines.push(`${p}.mode: ${e.mode}`);
    }
  }
  return lines;
}

/**
 * Collects `channels.*` lines for `parseConfigYaml`. A `channels.*` line that is
 * neither a knob nor an entry field is warned about here (the `channels.`
 * known-key prefix suppresses the generic notice).
 */
export function createChannelsCollector(): {
  lines: ChannelsLine[];
  warnings: string[];
  add(line: string, lineNo: number): void;
} {
  const lines: ChannelsLine[] = [];
  const warnings: string[] = [];
  return {
    lines,
    warnings,
    add(line, lineNo) {
      const parsed = parseChannelsLine(line);
      if (parsed) {
        lines.push({ ...parsed, value: parseConfigScalar(parsed.value) });
        return;
      }
      const bad = line.match(/^(channels\.[^:]*):/);
      warnings.push(
        `config.yaml:${lineNo} unknown key '${bad ? bad[1] : line}' — expected channels.<platform>.<selector>.<prompt|skills|model|tier|identity|metadata|inherit|silent|mode> or channels.<platform>.<allow_name_matching|fetch_metadata>`,
      );
    },
  };
}
