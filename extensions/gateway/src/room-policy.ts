import { createHash } from 'node:crypto';
import { sanitizeTemplateTokens } from '@ethosagent/safety-injection';
import type { ModelTierName } from '@ethosagent/types';

// Per-room prompt and policy resolution (plan/phases/channel-prompts.md §3.1, §3.4, §3.8).
// Pure: no I/O, no logging. The table is static per process and built by the
// composition root; this module only looks entries up and renders the block.

export interface RoomEntry {
  prompt?: string;
  skills?: string[];
  /** Model-registry alias -> RunOptions.modelOverride. */
  model?: string;
  /** -> RunOptions.tierOverride (mutually exclusive with `model`). */
  tier?: ModelTierName;
  /** Bot-identity line in rooms. Default true. */
  identity?: boolean;
  /** Include untrusted room metadata. Default false. */
  metadata?: boolean;
  /** false: do not fall back to parent entries or the wildcard for unset fields. */
  inherit?: boolean;
  /** NO_REPLY sends nothing in this room (plan L11, D20). Default false. */
  silent?: boolean;
  /** Default reply mode, a read-only fallback below the runtime override (plan L12, D11). */
  mode?: string;
}

export interface PlatformRoomPolicy {
  entries: Record<string, RoomEntry>;
  allowNameMatching?: boolean;
  fetchMetadata?: boolean;
}

export type RoomPolicyTable = Record<string, PlatformRoomPolicy>;

export type RoomMatchSource = 'topic' | 'direct' | 'parent' | 'name' | 'wildcard' | 'none';

export interface RoomPolicyInput {
  platform: string;
  chatId: string;
  threadId?: string;
  isDm: boolean;
  roomName?: string;
}

export interface ResolvedRoomPolicy {
  prompt: string | undefined;
  skills: string[] | undefined;
  model: string | undefined;
  tier: ModelTierName | undefined;
  identity: boolean;
  metadata: boolean;
  silent: boolean;
  /** Default reply mode from the most specific layer that set one. */
  mode: string | undefined;
  /** The selector that supplied `mode` (for `/channel`). */
  modeKey: string | undefined;
  matchKey: string | undefined;
  matchSource: RoomMatchSource;
  /** Selectors consulted, most specific first (wildcard last when used). For `/channel`. */
  layers: string[];
  /**
   * The pieces `prompt` is joined from, least specific first (the last element
   * is the most specific layer). A lone wildcard prompt is a single element.
   * `RoomTurnPolicies.forTurn` drops from the end to honour the whole-block cap.
   */
  promptLayers: Array<{ key: string; prompt: string }>;
}

/** Platforms whose thread id is itself a room id (Discord: threads are channels). */
const THREAD_IS_ROOM: ReadonlySet<string> = new Set(['discord']);

const WILDCARD_ROOM = '*';
const WILDCARD_DM = '*dm';

const has = (entries: Record<string, RoomEntry>, key: string): boolean =>
  Object.hasOwn(entries, key);

const nonBlank = (s: string | undefined): s is string => typeof s === 'string' && s.trim() !== '';

/** Lowercase, non-alphanumerics collapsed to '-', trimmed. Matches `name:<slug>` selectors. */
export function slugRoomName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface ChainLink {
  key: string;
  source: 'topic' | 'direct' | 'parent' | 'name';
}

export function resolveRoomPolicy(
  table: RoomPolicyTable,
  input: RoomPolicyInput,
): ResolvedRoomPolicy {
  const empty: ResolvedRoomPolicy = {
    prompt: undefined,
    skills: undefined,
    model: undefined,
    tier: undefined,
    identity: true,
    metadata: false,
    silent: false,
    mode: undefined,
    modeKey: undefined,
    matchKey: undefined,
    matchSource: 'none',
    layers: [],
    promptLayers: [],
  };
  if (!Object.hasOwn(table, input.platform)) return empty;
  const p = table[input.platform];
  if (!p || typeof p.entries !== 'object' || p.entries === null) return empty;
  const entries = p.entries;

  // Plan D3: exact thread (Discord) first, then nested topic, then the room.
  const chain: ChainLink[] = [];
  if (input.threadId) {
    if (THREAD_IS_ROOM.has(input.platform) && has(entries, input.threadId)) {
      chain.push({ key: input.threadId, source: 'direct' });
    }
    const topicKey = `${input.chatId}.topics.${input.threadId}`;
    if (has(entries, topicKey)) chain.push({ key: topicKey, source: 'topic' });
  }

  const roomCandidates: ChainLink[] = [{ key: input.chatId, source: 'direct' }];
  if (p.allowNameMatching && input.roomName) {
    const s = slugRoomName(input.roomName);
    if (s) roomCandidates.push({ key: `name:${s}`, source: 'name' });
  }
  const room = roomCandidates.find((c) => has(entries, c.key));
  if (room) chain.push({ key: room.key, source: input.threadId ? 'parent' : room.source });

  const wild = input.isDm ? WILDCARD_DM : WILDCARD_ROOM;
  const wildE = has(entries, wild) ? entries[wild] : undefined;

  const stop = chain.findIndex((c) => entries[c.key]?.inherit === false);
  const links = stop === -1 ? chain : chain.slice(0, stop + 1);
  const useWild = stop === -1;
  const layerEntries = links.map((l) => entries[l.key] as RoomEntry);
  const wildLayer = useWild ? wildE : undefined;
  const all: RoomEntry[] = wildLayer ? [...layerEntries, wildLayer] : layerEntries;
  const allKeys: string[] = wildLayer
    ? [...links.map((l) => l.key), wild]
    : links.map((l) => l.key);

  const first = <K extends keyof RoomEntry>(f: K): RoomEntry[K] | undefined => {
    for (const e of all) if (e[f] !== undefined) return e[f];
    return undefined;
  };

  // Least specific first: parent, then topic, then direct thread.
  const layerPrompts = links
    .map((l, i) => ({ key: l.key, e: layerEntries[i] as RoomEntry }))
    .filter((x) => nonBlank(x.e.prompt))
    .reverse()
    .map((x) => ({ key: x.key, prompt: x.e.prompt as string }));
  const promptLayers =
    layerPrompts.length > 0
      ? layerPrompts
      : nonBlank(wildLayer?.prompt)
        ? [{ key: wild, prompt: wildLayer.prompt }]
        : [];
  const prompt =
    promptLayers.length > 0 ? promptLayers.map((l) => l.prompt).join('\n\n') : undefined;

  const modeAt = all.findIndex((e) => e.mode !== undefined);
  const head = links[0];
  return {
    prompt,
    skills: first('skills'),
    model: first('model'),
    tier: first('tier'),
    identity: first('identity') ?? true,
    metadata: first('metadata') ?? false,
    silent: first('silent') ?? false,
    mode: modeAt === -1 ? undefined : all[modeAt]?.mode,
    modeKey: modeAt === -1 ? undefined : allKeys[modeAt],
    matchKey: head?.key ?? (wildLayer ? wild : undefined),
    matchSource: head?.source ?? (wildLayer ? 'wildcard' : 'none'),
    layers: [...links.map((l) => l.key), ...(wildLayer ? [wild] : [])],
    promptLayers,
  };
}

export interface RoomIdentity {
  handle: string;
  platformUserId?: string;
  isDm: boolean;
}

const HANDLE_MAX = 64;

function sanitizeIdentityToken(raw: string): string {
  return raw.replace(/[^\w.\- ]/g, '').slice(0, HANDLE_MAX);
}

/**
 * Renders the static room block: the resolved prompt, then (rooms only, when
 * enabled and the adapter supplied a handle) the fixed identity line. Returns
 * undefined, never an empty string, when there is nothing to say. Deterministic:
 * no date, sender or per-turn content.
 */
export function renderRoomPrompt(
  resolved: Pick<ResolvedRoomPolicy, 'prompt' | 'identity'> & { silent?: boolean },
  identity?: RoomIdentity,
): string | undefined {
  const parts: string[] = [];
  if (nonBlank(resolved.prompt)) parts.push(resolved.prompt);

  if (identity && !identity.isDm && resolved.identity !== false) {
    const handle = sanitizeIdentityToken(identity.handle);
    if (handle) {
      const id = identity.platformUserId ? sanitizeIdentityToken(identity.platformUserId) : '';
      const idPart = id ? `, platform id ${id}` : '';
      parts.push(
        `In this room you are the bot "@${handle}"${idPart}. Mentions are routed to you by the gateway, so "@${handle}" may have been removed from the text you see. A mention of any other name or id is not a mention of you.`,
      );
    }
  }
  if (resolved.silent === true) parts.push(ROOM_SILENT_LINE);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * The fixed line a silent room appends (plan L11). The marker it names is
 * honoured only in rooms that set `silent: true`, enforced by
 * `shouldSuppressSilentReply` (./silent-reply.ts), pinned by
 * `__tests__/room-silence.test.ts`.
 */
export const ROOM_SILENT_LINE = 'To send nothing in this room, reply with exactly NO_REPLY.';

/**
 * The room's configured default reply mode (plan L12): a pure view over the
 * same resolver, so adapters never hold a second one. `key` is the selector
 * that supplied it. Undefined when no layer sets a mode.
 */
export function roomModeDefault(
  table: RoomPolicyTable,
  input: RoomPolicyInput,
): { mode: string; key: string } | undefined {
  const r = resolveRoomPolicy(table, input);
  return r.mode !== undefined && r.modeKey !== undefined
    ? { mode: r.mode, key: r.modeKey }
    : undefined;
}

/** First 8 hex chars of sha256 of the rendered block. For pinning and `/channel`. */
export function roomPolicyDigest(rendered: string): string {
  return createHash('sha256').update(rendered).digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------------------
// Table construction (plan §3.3, D6, D15, D16). Pure: the composition root reads
// config and prompt files through Storage and hands the raw pieces here.
// ---------------------------------------------------------------------------

/** Per-layer prompt cap, inline or file. Over it: dropped, never truncated (D16). */
export const ROOM_PROMPT_LAYER_MAX_CHARS = 4000;
/** Cap on the whole rendered room block. Enforced per turn by `RoomTurnPolicies.forTurn`. */
export const ROOM_BLOCK_MAX_CHARS = 8000;

/** One `~/.ethos/channels/<platform>/<base>.md` file, already read. */
export interface RoomPromptFile {
  platform: string;
  /** File name without `.md`: `_rooms`, `_dms`, `name_<slug>` or a selector. */
  base: string;
  path: string;
  body: string;
}

export interface RoomPolicySources {
  /** `EthosConfig.channels`. */
  channels?: Record<string, PlatformRoomPolicy>;
  files?: readonly RoomPromptFile[];
}

export interface RoomPolicyBuildOptions {
  /**
   * Returns a problem description when `model` is not usable, undefined when it is.
   * Omitted: every model value is accepted as written.
   */
  validateModel?: (model: string) => string | undefined;
  /**
   * Whether `mode` is in `platform`'s reply-mode enum (plan L12). False: the
   * field is dropped with the generic warning; a string: dropped, and the string
   * is the warning's reason (a full clause that names the mode). Omitted: every
   * mode token is accepted.
   */
  validateMode?: (platform: string, mode: string) => boolean | string;
}

export interface RoomPolicyBuildResult {
  table: RoomPolicyTable;
  warnings: string[];
}

/** `_rooms` -> `*`, `_dms` -> `*dm`, `name_<slug>` -> `name:<slug>`, else as-is. */
export function roomSelectorFromFile(base: string): string {
  if (base === '_rooms') return '*';
  if (base === '_dms') return '*dm';
  if (base.startsWith('name_') && base.length > 5) return `name:${base.slice(5)}`;
  return base;
}

/** `name:<x>` selectors are matched by slug; store them slugged. Undefined = unusable. */
function normaliseSelector(
  selector: string,
  label: string,
  warnings: string[],
): string | undefined {
  if (!selector.startsWith('name:')) return selector;
  const written = selector.slice(5);
  const slug = slugRoomName(written);
  if (slug === '') {
    warnings.push(`${label}: selector '${selector}' has no usable name — ignored.`);
    return undefined;
  }
  if (slug !== written) {
    warnings.push(
      `${label}: selector '${selector}' is not a slug — stored as 'name:${slug}' (names are matched by slug).`,
    );
  }
  return `name:${slug}`;
}

function acceptPrompt(raw: string, label: string, warnings: string[]): string | undefined {
  const text = sanitizeTemplateTokens(raw).content;
  if (text.length > ROOM_PROMPT_LAYER_MAX_CHARS) {
    warnings.push(
      `${label}: prompt rejected: ${text.length} > ${ROOM_PROMPT_LAYER_MAX_CHARS} chars — dropped, not truncated.`,
    );
    return undefined;
  }
  return text.trim() === '' ? undefined : text;
}

const newPlatform = (): PlatformRoomPolicy => ({ entries: Object.create(null) });

/**
 * Builds the table the Gateway resolves against. Never throws on bad content:
 * an over-cap, invalid or colliding piece is dropped with a warning.
 */
export function buildRoomPolicyTable(
  sources: RoomPolicySources,
  opts: RoomPolicyBuildOptions = {},
): RoomPolicyBuildResult {
  const warnings: string[] = [];
  const table: RoomPolicyTable = Object.create(null);
  // `${platform}\0${selector}` of entries whose INLINE prompt was set (kept or dropped).
  const inline = new Set<string>();

  for (const [platform, cfg] of Object.entries(sources.channels ?? {})) {
    const out = newPlatform();
    if (cfg.allowNameMatching !== undefined) out.allowNameMatching = cfg.allowNameMatching;
    if (cfg.fetchMetadata !== undefined) out.fetchMetadata = cfg.fetchMetadata;
    for (const [written, raw] of Object.entries(cfg.entries)) {
      const selector = normaliseSelector(written, `channels.${platform}.${written}`, warnings);
      if (selector === undefined) continue;
      const entry: RoomEntry = { ...(out.entries[selector] ?? {}), ...raw };
      if (raw.prompt !== undefined) {
        inline.add(`${platform}\0${selector}`);
        const p = acceptPrompt(raw.prompt, `channels.${platform}.${selector}.prompt`, warnings);
        if (p === undefined) delete entry.prompt;
        else entry.prompt = p;
      }
      out.entries[selector] = entry;
    }
    table[platform] = out;
  }

  for (const f of sources.files ?? []) {
    const selector = normaliseSelector(roomSelectorFromFile(f.base), f.path, warnings);
    if (selector === undefined) continue;
    if (inline.has(`${f.platform}\0${selector}`)) {
      warnings.push(
        `channels.${f.platform}.${selector}.prompt (config.yaml) and ${f.path} both set a prompt — using config.yaml, ignoring the file.`,
      );
      continue;
    }
    const prompt = acceptPrompt(f.body, f.path, warnings);
    if (prompt === undefined) continue;
    const plat = table[f.platform] ?? newPlatform();
    table[f.platform] = plat;
    plat.entries[selector] = { ...(plat.entries[selector] ?? {}), prompt };
  }

  if (opts.validateModel) {
    for (const [platform, plat] of Object.entries(table)) {
      for (const [selector, entry] of Object.entries(plat.entries)) {
        if (entry.model === undefined) continue;
        const problem = opts.validateModel(entry.model);
        if (problem === undefined) continue;
        warnings.push(
          `channels.${platform}.${selector}.model: '${entry.model}' ${problem} — ignored.`,
        );
        delete entry.model;
      }
    }
  }
  if (opts.validateMode) {
    for (const [platform, plat] of Object.entries(table)) {
      for (const [selector, entry] of Object.entries(plat.entries)) {
        if (entry.mode === undefined) continue;
        const verdict = opts.validateMode(platform, entry.mode);
        if (verdict === true) continue;
        warnings.push(
          typeof verdict === 'string'
            ? `channels.${platform}.${selector}.mode: ${verdict} — ignored.`
            : `channels.${platform}.${selector}.mode: '${entry.mode}' is not a reply mode for ${platform} — ignored.`,
        );
        delete entry.mode;
      }
    }
  }
  return { table, warnings };
}
