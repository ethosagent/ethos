// Shared per-room policy logic (plan channel-prompts-ui §3.1, D1/D2/D13/D15).
//
// One implementation behind `ethos channels`, both gateway hosts
// (apps/ethos/src/commands/gateway.ts) and the web-api room editor, so no
// surface carries a second resolver. It reaches the gateway only through the
// pure `@ethosagent/gateway/room-policy` subpath (not the gateway root, which
// pulls the stores, spool and ledger). It is also exported as its own subpath
// (`@ethosagent/wiring/room-policy`) so a lazily imported CLI command does not
// pay for the whole wiring barrel.
//
// Prompt files are read through Storage only (apps/ethos/src/__tests__/no-raw-fs.test.ts).
// Reply-mode enums are injected, never imported: wiring takes no dependency on
// each platform's config surface (D2).

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { type EthosConfig, parseModelDeclaration } from '@ethosagent/config';
import {
  buildRoomPolicyTable,
  type RoomPolicyInput,
  type RoomPolicyTable,
  RoomTurnPolicies,
  resolveRoomPolicy,
  roomSelectorFromFile,
  slugRoomName,
} from '@ethosagent/gateway/room-policy';
import { EthosError, type Storage } from '@ethosagent/types';

export type { RoomPolicyInput, RoomPolicyTable };

// ---------------------------------------------------------------------------
// Prompt files
// ---------------------------------------------------------------------------

/** A prompt file larger than this is not read into the table. */
export const ROOM_PROMPT_FILE_MAX_BYTES = 16 * 1024;

/** Structurally the gateway's `RoomPromptFile`. */
export interface RawRoomPromptFile {
  platform: string;
  base: string;
  path: string;
  body: string;
}

export interface RoomPromptFileRead {
  files: RawRoomPromptFile[];
  warnings: string[];
}

const PLATFORM_RE = /^[a-z0-9_-]+$/;

/** `<stateDir>/channels/<platform>/<name>.md`, each under 16 KiB. Never throws on content. */
export async function readRoomPromptFiles(
  storage: Storage,
  stateDir: string,
): Promise<RoomPromptFileRead> {
  const files: RawRoomPromptFile[] = [];
  const warnings: string[] = [];
  const root = `${stateDir}/channels`;
  for (const pdir of await storage.listEntries(root)) {
    if (!pdir.isDir || !PLATFORM_RE.test(pdir.name)) continue;
    const platform = pdir.name;
    for (const f of await storage.listEntries(`${root}/${platform}`)) {
      if (f.isDir || !f.name.endsWith('.md') || f.name.length <= 3) continue;
      const path = `${root}/${platform}/${f.name}`;
      // Cheap pre-check from the listing, before reading the bytes.
      if (f.size !== undefined && f.size > ROOM_PROMPT_FILE_MAX_BYTES) {
        warnings.push(`${path}: file is over 16 KiB — skipped.`);
        continue;
      }
      const body = await storage.read(path);
      if (body === null) continue;
      if (Buffer.byteLength(body, 'utf-8') > ROOM_PROMPT_FILE_MAX_BYTES) {
        warnings.push(`${path}: file is over 16 KiB — skipped.`);
        continue;
      }
      files.push({ platform, base: f.name.slice(0, -3), path, body });
    }
  }
  return { files, warnings };
}

// ---------------------------------------------------------------------------
// Loading the table (the one path both gateway hosts and the CLI use)
// ---------------------------------------------------------------------------

/** Reply-mode enum per platform, injected by the caller (D2). A platform absent here accepts any token. */
export type RoomModeEnums = Readonly<Record<string, readonly string[]>>;

export interface LoadRoomPoliciesOptions {
  /** The state dir holding `channels/<platform>/*.md` (`ethosDir()` for the CLI). */
  stateDir: string;
  modeEnums: RoomModeEnums;
  /**
   * Prompt files to build from instead of reading `<stateDir>/channels`. The
   * room editor validates a candidate save against the current files with one
   * file replaced, so the boot build judges exactly what would be written
   * (plan channel-prompts-ui §3.4); nothing is read or written for it.
   */
  files?: readonly RawRoomPromptFile[];
}

/**
 * Reads prompt files through Storage, builds the table in the gateway
 * (`buildRoomPolicyTable`) and returns it with its warnings. The table is
 * undefined when no platform is configured, so an unconfigured deployment does
 * no per-turn room work.
 *
 * Model values: with a model registry, a value must parse (via the config's
 * `parseModelDeclaration`) as a role or an alias; with no registry the value is
 * a raw model id, as core's legacy path takes it (`resolveTurnModel`).
 */
export async function loadRoomPolicies(
  storage: Storage,
  config: Pick<EthosConfig, 'channels' | 'modelRegistry'>,
  opts: LoadRoomPoliciesOptions,
): Promise<{ table: RoomPolicyTable | undefined; warnings: string[] }> {
  const read: RoomPromptFileRead = opts.files
    ? { files: [...opts.files], warnings: [] }
    : await readRoomPromptFiles(storage, opts.stateDir);
  const registryEntries = Object.keys(config.modelRegistry?.entries ?? {});
  const built = buildRoomPolicyTable(
    { channels: config.channels, files: read.files },
    {
      validateModel: (model) => {
        if (registryEntries.length === 0) return undefined;
        const parsed = parseModelDeclaration(model, config);
        if (parsed.kind === 'role' || parsed.kind === 'alias') return undefined;
        return `is not a role or model-registry alias (configured: ${registryEntries.join(', ')})`;
      },
      // Each adapter's own enum decides what a `mode` may be (plan channel-prompts L12).
      // A platform with no known enum (a plugin channel, or an adapter that failed to
      // load) accepts the token; an adapter with an enum still fails closed on
      // anything unexpected in `evaluateChannelMode` (`supportedModes`).
      validateMode: (platform, mode) => {
        // Telegram's `regex_match` is in its enum, but a room entry has no pattern
        // field (the pattern lives in the runtime override), so it can never work here.
        if (platform === 'telegram' && mode === 'regex_match') {
          return "'regex_match' needs a pattern — set it at runtime with the channel-mode command";
        }
        const modes = opts.modeEnums[platform];
        return modes === undefined || modes.includes(mode);
      },
    },
  );
  return {
    table: Object.keys(built.table).length > 0 ? built.table : undefined,
    warnings: [...read.warnings, ...built.warnings],
  };
}

// ---------------------------------------------------------------------------
// Preview (`ethos channels resolve`)
// ---------------------------------------------------------------------------

/**
 * The resolver's answer plus the rendered room block and its digest. The block
 * has no identity line (the bot handle is known only to a live adapter), so a
 * live digest differs when identity is on.
 */
export function previewRoomPolicy(table: RoomPolicyTable, input: RoomPolicyInput) {
  const resolved = resolveRoomPolicy(table, input);
  // The live path (`RoomTurnPolicies.forTurn`, no identity): it applies the
  // 8,000-char whole-block cap, so this digest equals a live identity-off one.
  const turn = new RoomTurnPolicies(table).forTurn(input, undefined);
  return {
    resolved,
    block: turn?.prompt,
    digest: turn?.digest,
    trimmed: turn?.trimmed ?? [],
  };
}

/**
 * The document `ethos channels resolve --json` prints, and the `previewRoomPolicy`
 * RPC returns, field for field (D13). Key order is part of the contract: the CLI
 * prints `JSON.stringify` of this value (pinned by
 * `apps/ethos/src/commands/__tests__/channels-resolve.test.ts`).
 */
export function previewRoomPolicyJson(
  table: RoomPolicyTable,
  input: RoomPolicyInput,
  warnings: readonly string[],
) {
  const { resolved, block, digest } = previewRoomPolicy(table, input);
  return {
    ok: true as const,
    platform: input.platform,
    chatId: input.chatId,
    threadId: input.threadId ?? null,
    isDm: input.isDm,
    roomName: input.roomName ?? null,
    match: {
      key: resolved.matchKey ?? null,
      source: resolved.matchSource,
      layers: resolved.layers,
    },
    fields: {
      skills: resolved.skills ?? null,
      model: resolved.model ?? null,
      tier: resolved.tier ?? null,
      identity: resolved.identity,
      metadata: resolved.metadata,
      silent: resolved.silent,
      mode: resolved.mode ?? null,
      modeKey: resolved.modeKey ?? null,
    },
    promptLayers: resolved.promptLayers.map((l) => ({ key: l.key, chars: l.prompt.length })),
    digest: digest ?? null,
    block: block ?? null,
    identityLineOmitted: true as const,
    warnings: [...warnings],
  };
}

/** The selector as the table stores it: `name:<x>` selectors are slugged. */
export function normalisedRoomSelector(selector: string): string {
  return selector.startsWith('name:') ? `name:${slugRoomName(selector.slice(5))}` : selector;
}

/** The selector a room-prompt file name (`_rooms`, `name_<slug>`, ...) maps to, as the table stores it. */
export function roomFileSelector(base: string): string {
  return normalisedRoomSelector(roomSelectorFromFile(base));
}

// ---------------------------------------------------------------------------
// Listing (`ethos channels list`, and the editor's rows)
// ---------------------------------------------------------------------------

/** Entry fields shown by `list`, in display order. */
const ENTRY_FIELDS: readonly string[] = [
  'prompt',
  'skills',
  'model',
  'tier',
  'identity',
  'metadata',
  'inherit',
  'silent',
  'mode',
];

export interface RoomEntryRow {
  selector: string;
  /** Fields set on the built entry, in display order. */
  fields: string[];
  /** `'config'` and/or the prompt file path; a file counts only when no inline prompt shadows it. */
  sources: string[];
}

/** Per platform, one row per built entry with the sources that contributed. */
export function describeRoomEntries(
  config: Pick<EthosConfig, 'channels'>,
  files: readonly RawRoomPromptFile[],
  table: RoomPolicyTable,
): Record<string, { entries: RoomEntryRow[] }> {
  const platforms: Record<string, { entries: RoomEntryRow[] }> = {};
  for (const [platform, plat] of Object.entries(table)) {
    const configEntries = Object.entries(config.channels?.[platform]?.entries ?? {});
    const configKeys = new Set(configEntries.map(([k]) => normalisedRoomSelector(k)));
    const inlinePrompt = new Set(
      configEntries
        .filter(([, e]) => e.prompt !== undefined)
        .map(([k]) => normalisedRoomSelector(k)),
    );
    const rows: RoomEntryRow[] = Object.entries(plat.entries).map(([selector, entry]) => {
      const sources: string[] = [];
      if (configKeys.has(selector)) sources.push('config');
      // A file only counts when no inline prompt shadows it (buildRoomPolicyTable: config wins).
      if (!inlinePrompt.has(selector)) {
        for (const f of files) {
          if (f.platform === platform && roomFileSelector(f.base) === selector)
            sources.push(f.path);
        }
      }
      return {
        selector,
        fields: ENTRY_FIELDS.filter((f) =>
          Object.entries(entry).some(([k, v]) => k === f && v !== undefined),
        ),
        sources,
      };
    });
    if (rows.length > 0) platforms[platform] = { entries: rows };
  }
  return platforms;
}

/**
 * Optimistic-concurrency token (D7): sha256-8 of the selector's raw config pairs
 * (in file order) and its prompt file body. `fileBody` null means "no file"; an
 * empty file is a different version.
 */
export function roomEntryVersion(
  pairs: ReadonlyArray<readonly [string, string]>,
  fileBody: string | null,
): string {
  return createHash('sha256')
    .update(JSON.stringify([pairs.map(([k, v]) => [k, v]), fileBody]))
    .digest('hex')
    .slice(0, 8);
}

// ---------------------------------------------------------------------------
// Selectors: file names and validation (D15)
// ---------------------------------------------------------------------------

/**
 * The prompt file name (without `.md`) for a selector: the exact inverse of the
 * gateway's `roomSelectorFromFile` for every selector `checkRoomSelector` accepts
 * (pinned by `__tests__/room-policy-selectors.test.ts`).
 */
export function roomFileBase(selector: string): string {
  if (selector === '*') return '_rooms';
  if (selector === '*dm') return '_dms';
  if (selector.startsWith('name:')) return `name_${selector.slice(5)}`;
  return selector;
}

/** A `.md` path under `<dataDir>/channels/<platform>/`, asserted to stay there. Throws INVALID_INPUT. */
export function roomPromptFilePath(dataDir: string, platform: string, selector: string): string {
  const fail = (cause: string): never => {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause,
      action: 'Use a room id without path characters.',
    });
  };
  if (!PLATFORM_RE.test(platform)) fail(`'${platform}' is not a valid platform name.`);
  const hard = hardRefusal(selector);
  if (hard !== undefined) fail(hard);
  const base = roomFileBase(selector);
  const dir = posix.join(dataDir, 'channels', platform);
  const path = posix.join(dir, `${base}.md`);
  if (posix.dirname(path) !== dir || posix.basename(path) !== `${base}.md`) {
    fail(`Room id '${selector}' would write outside channels/${platform}/.`);
  }
  return path;
}

export const ROOM_SELECTOR_MAX_CHARS = 160;

export type RoomSelectorKind = 'rooms' | 'dms' | 'room' | 'topic' | 'name';

export interface RoomSelectorKnobs {
  /** `channels.<platform>.allow_name_matching`; `name:` selectors are refused unless true. */
  allowNameMatching?: boolean;
  /** Selectors already present, for the case-collision warning. */
  existingSelectors?: readonly string[];
}

export type RoomSelectorCheck =
  | { ok: true; kind: RoomSelectorKind; warnings: string[] }
  | { ok: false; reason: string };

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** Path-safety refusals that apply to every platform. */
function hardRefusal(selector: string): string | undefined {
  if (selector === '') return 'Room id is empty.';
  if (selector.length > ROOM_SELECTOR_MAX_CHARS) {
    return `Room id is longer than ${ROOM_SELECTOR_MAX_CHARS} characters.`;
  }
  if (CONTROL_RE.test(selector)) return 'Room ids cannot contain control characters.';
  if (/\s/u.test(selector)) return 'Room ids cannot contain whitespace.';
  if (selector.includes('..')) return "Room ids cannot contain '..'.";
  if (selector.includes('/')) return "Room ids cannot contain '/'.";
  if (selector.includes('\\')) return "Room ids cannot contain '\\'.";
  // `*` and `*dm` are the only selectors that may hold `*`; every other glob or
  // Windows-illegal character would reach a prompt file name raw (roomFileBase).
  if (selector !== '*' && selector !== '*dm' && /[*?<>|"]/.test(selector)) {
    return `Room ids cannot contain any of * ? < > | " (only '*' and '*dm' are wildcards).`;
  }
  // `:` is legal only as the `name:` prefix. Anywhere else it would be read back
  // as a field separator by parseChannelsLine (`C0.prompt:x` re-routes the key).
  const afterPrefix = selector.startsWith('name:') ? selector.slice(5) : selector;
  if (afterPrefix.includes(':')) {
    return "Room ids cannot contain ':' (only the 'name:' prefix may).";
  }
  if (selector.startsWith('.')) return "Room ids cannot start with '.'.";
  if (selector.startsWith('_')) {
    return "Room ids cannot start with '_' (_rooms and _dms are reserved file names).";
  }
  if (selector.startsWith('name_')) {
    return "Room ids cannot start with 'name_' (it would collide with name: prompt files).";
  }
  return undefined;
}

const SHAPES: Record<string, { re: RegExp; label: string }> = {
  slack: { re: /^[A-Z0-9]{2,32}$/, label: "a Slack channel id (usually 'C…' or 'G…')" },
  discord: { re: /^\d{5,25}$/, label: 'a Discord channel id (digits)' },
  telegram: { re: /^-?\d{1,20}$/, label: 'a Telegram chat id (a number, negative for groups)' },
  whatsapp: {
    re: /^[0-9]{5,32}(-[0-9]+)?@(g\.us|s\.whatsapp\.net|lid)$/,
    label: "a WhatsApp chat id ('…@g.us', '…@s.whatsapp.net' or '…@lid')",
  },
};

const NO_TOPICS = new Set(['slack', 'whatsapp']);
const TOPICS = '.topics.';

function shapeWarning(platform: string, id: string): string | undefined {
  const shape = SHAPES[platform];
  if (shape === undefined || shape.re.test(id)) return undefined;
  return `Room id '${id}' does not look like ${shape.label}. Saved anyway.`;
}

/**
 * Two-tier selector validation (D15). Path-safety rules are hard refusals and
 * apply to every platform and plugin; the per-platform id shapes are warnings
 * only, so a plugin platform or a new id prefix still works. Enforcer of the
 * "selector never escapes channels/<platform>/" guarantee, with
 * `roomPromptFilePath` as the second check; pinned by
 * `__tests__/room-policy-selectors.test.ts`.
 */
export function checkRoomSelector(
  platform: string,
  selector: string,
  knobs: RoomSelectorKnobs = {},
): RoomSelectorCheck {
  if (!PLATFORM_RE.test(platform)) {
    return { ok: false, reason: `'${platform}' is not a valid platform name.` };
  }
  const hard = hardRefusal(selector);
  if (hard !== undefined) return { ok: false, reason: hard };

  const warnings: string[] = [];
  let kind: RoomSelectorKind;

  if (selector === '*') kind = 'rooms';
  else if (selector === '*dm') kind = 'dms';
  else if (selector.startsWith('name:')) {
    kind = 'name';
    if (knobs.allowNameMatching !== true) {
      return {
        ok: false,
        reason: `'${selector}' is a name selector, and channels.${platform}.allow_name_matching is off, so it would never match.`,
      };
    }
    const written = selector.slice(5);
    const slug = slugRoomName(written);
    if (slug === '') return { ok: false, reason: `'${selector}' has no usable room name.` };
    if (slug !== written) {
      warnings.push(`Name '${written}' is not a slug; it is stored as 'name:${slug}'.`);
    }
  } else if (selector.includes(TOPICS)) {
    kind = 'topic';
    if (NO_TOPICS.has(platform)) {
      return {
        ok: false,
        reason: `${platform} has no topics; a '.topics.' selector never matches.`,
      };
    }
    const at = selector.indexOf(TOPICS);
    const room = selector.slice(0, at);
    const sub = selector.slice(at + TOPICS.length);
    if (room === '' || sub === '') {
      return { ok: false, reason: "A topic selector is '<room id>.topics.<topic id>'." };
    }
    if (platform === 'telegram' && sub === '1') {
      return {
        ok: false,
        reason:
          "Telegram topic 1 is the General topic and has no thread id, so it never matches; set the room's own entry instead.",
      };
    }
    const w = shapeWarning(platform, room);
    if (w) warnings.push(w);
    if (!/^\d+$/.test(sub)) {
      warnings.push(`Topic id '${sub}' is not a number; topic ids are numeric. Saved anyway.`);
    }
  } else {
    kind = 'room';
    const w = shapeWarning(platform, selector);
    if (w) warnings.push(w);
  }

  const lower = selector.toLowerCase();
  if ((knobs.existingSelectors ?? []).some((e) => e !== selector && e.toLowerCase() === lower)) {
    warnings.push(
      `An existing entry differs only by case from '${selector}'. Room ids are case-sensitive, so these are two entries.`,
    );
  }
  return { ok: true, kind, warnings };
}
