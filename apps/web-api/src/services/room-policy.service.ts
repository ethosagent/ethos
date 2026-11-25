import {
  type EthosConfig,
  parseChannelsLine,
  parseConfigScalar,
  parseConfigYaml,
  renderConfigScalar,
} from '@ethosagent/config';
import { EthosError, type SessionStore, type Storage } from '@ethosagent/types';
import {
  ROOM_MODES,
  type RoomEntryFields,
  type RoomEntryView,
  type RoomPlatform,
} from '@ethosagent/web-contracts';
import {
  checkRoomSelector,
  isIncognitoSession,
  laneKeyChatId,
  loadRoomPolicies,
  normalisedRoomSelector,
  previewRoomPolicyJson,
  type RawRoomPromptFile,
  type RoomPolicyTable,
  readRoomPromptFiles,
  roomEntryVersion,
  roomFileBase,
  roomPromptFilePath,
} from '@ethosagent/wiring';
import type { ConfigRepository } from '../repositories/config.repository';

// Per-room policy editor (plan channel-prompts-ui §3.2-§3.5, L4).
//
// Reads and writes the SAME two homes `ethos channels` and the gateway boot
// path read: typed `channels.<platform>.<selector>.*` lines in config.yaml and
// prompt files under `<dataDir>/channels/<platform>/<base>.md`. It owns no
// resolver: validation, the version token, the preview JSON and the selector
// grammar all come from `@ethosagent/wiring` (room-policy.ts), the one
// implementation behind the CLI and both gateway hosts.
//
// Storage trust (the answer to "can a prompt-injected turn reach this?"): the
// `Storage` handed in is the operator surface's plain FsStorage (`createWebApi`
// defaults to a plain FsStorage instance; `ethos serve` passes `getStorage()`, which is
// an FsStorage, apps/ethos/src/wiring.ts), never a turn-scoped `ScopedStorage`,
// so `STATE_DIR_DENY_ENTRIES` (`channels`, `config.yaml`;
// packages/storage-fs/src/sensitive-paths.ts) does not block this service, by
// design: it is a floor for agent turns. What keeps an agent out of these RPCs
// is the route, not the Storage: `platforms` is not a SCOPE_MAP namespace
// (apps/web-api/src/middleware/dual-auth.ts), so bearer keys get 403, pinned by
// `__tests__/routes/room-policy-rpc.test.ts`.
//
// Limitation: skill ids are not checked against the installed skills here. The
// bound personality (and the bot it is bound through) is only known to the
// running gateway, and web-api has no cheap per-room lookup of it, so a skill
// the gateway cannot load is skipped at runtime, not rejected on save. The drawer
// (useRoomSkillOptions) flags ids outside the global and bound-bot skills.
//
// Limitation: locks are in-process (one promise chain here, plus
// ConfigRepository's). A CLI or hand edit landing between the version check
// and the write in another process is not detected.

/** The gateway's cap on one prompt layer after template-token sanitising (room-policy.ts). */
const PROMPT_MAX_CHARS = 4000;
/** The loader skips a prompt file over this many bytes (ROOM_PROMPT_FILE_MAX_BYTES). */
const PROMPT_MAX_BYTES = 16 * 1024;
const RECENT_DEFAULT = 25;
const RECENT_SCAN = 200;
/** `Session.metadata` key holding a lane's DM-ness: ROOM_POLICY_IS_DM_KEY, extensions/gateway/src/room-turn.ts. */
const IS_DM_KEY = 'roomPolicyIsDm';
const METADATA_PLATFORMS: ReadonlySet<string> = new Set(['slack', 'discord']);
const TIERS = ['trivial', 'default', 'deep', 'dreaming'] as const;
const FIELD_RE = '(?:prompt|skills|model|tier|identity|metadata|inherit|silent|mode)';
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

type Pair = [string, string];
type PreviewJson = ReturnType<typeof previewRoomPolicyJson>;

export interface RoomPolicyServiceOptions {
  storage: Storage;
  /** The state dir holding config.yaml and `channels/<platform>/*.md`. */
  dataDir: string;
  config: ConfigRepository;
  sessions: Pick<SessionStore, 'listSessions'>;
}

export type SetRoomPolicyResult =
  | { ok: true; entry: RoomEntryView; warnings: string[] }
  | {
      ok: false;
      reason: 'partial';
      fileWritten: boolean;
      /** A blank prompt deleted the existing prompt file. */
      fileRemoved: boolean;
      configWritten: boolean;
      cause: string;
    };

export type DeleteRoomPolicyResult =
  | { ok: true; removed: boolean }
  | {
      ok: false;
      reason: 'partial';
      fileRemoved: boolean;
      configRemoved: boolean;
      cause: string;
    };

interface EntryPair {
  pair: Pair;
  selector: string;
  field: string;
}

/** Everything one operation reads, taken together so the version it checks is the one it writes over. */
interface State {
  pairs: Pair[];
  parsed: EthosConfig;
  files: RawRoomPromptFile[];
  fileWarnings: string[];
}

interface Loaded {
  state: State;
  table: RoomPolicyTable | undefined;
  warnings: string[];
}

/** A half-applied write, remembered so the identical retry is not mistaken for a conflict. */
interface Pending {
  expected: string | null;
  pairs: string;
  fileBody: string | null;
  /** The request that half-landed; only its identical retry is let through. */
  request: string;
}

const invalid = (cause: string, action = 'Fix the field named above, then save again.') =>
  new EthosError({ code: 'INVALID_INPUT', cause, action });

function entryPairsOf(pairs: readonly Pair[], platform: string): EntryPair[] {
  const out: EntryPair[] = [];
  for (const pair of pairs) {
    const line = parseChannelsLine(`${pair[0]}: ${pair[1]}`);
    if (line?.kind === 'entry' && line.platform === platform) {
      out.push({ pair, selector: line.selector, field: line.field });
    }
  }
  return out;
}

const pairsFor = (pairs: readonly Pair[], platform: string, selector: string): Pair[] =>
  entryPairsOf(pairs, platform)
    .filter((e) => e.selector === selector)
    .map((e) => e.pair);

const selectorsOf = (pairs: readonly Pair[], files: readonly RawRoomPromptFile[], p: string) => {
  const out = new Set<string>();
  for (const e of entryPairsOf(pairs, p)) out.add(e.selector);
  for (const f of files) if (f.platform === p) out.add(fileSelector(f));
  return [...out];
};

/** The selector a file names as written (not slugged), the inverse of `roomFileBase`. */
function fileSelector(f: RawRoomPromptFile): string {
  if (f.base === '_rooms') return '*';
  if (f.base === '_dms') return '*dm';
  if (f.base.startsWith('name_') && f.base.length > 5) return `name:${f.base.slice(5)}`;
  return f.base;
}

const fileFor = (files: readonly RawRoomPromptFile[], platform: string, selector: string) =>
  files.find((f) => f.platform === platform && fileSelector(f) === selector);

/** A build warning about one of `entry`'s fields (`channels.<p>.<sel>.<field>: …` or the entry as a whole). */
function entryWarning(w: string, platform: string, selectors: readonly string[]): boolean {
  return selectors.some((sel) => {
    const head = `channels.${platform}.${sel}`;
    if (!w.startsWith(head)) return false;
    const rest = w.slice(head.length);
    return new RegExp(`^(?:\\.${FIELD_RE}[:\\s]|: )`).test(rest);
  });
}

/**
 * The ONE build warning that transforms instead of dropping: a `name:` selector
 * stored as its slug (extensions/gateway/src/room-policy.ts, buildRoomPolicyTable;
 * pinned by the 'name:Deploys' service test). Every other warning for the entry,
 * including that file's "has no usable name — ignored", means boot drops a field.
 */
const SLUG_NOTICE_RE = /: selector '[^']*' is not a slug — stored as /;

/** What boot would DROP (D5): every entry warning except the slug notice. */
const dropsAField = (w: string): boolean => !SLUG_NOTICE_RE.test(w);

export class RoomPolicyService {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: RoomPolicyServiceOptions) {}

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // ---------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------

  private async readState(): Promise<State> {
    const raw = await this.opts.config.read();
    const src = await this.opts.config.readSource();
    const read = await readRoomPromptFiles(this.opts.storage, this.opts.dataDir);
    return {
      pairs: (raw?.channelLines ?? []).map(([k, v]): Pair => [k, v]),
      parsed: parseConfigYaml(src ?? ''),
      files: read.files,
      fileWarnings: read.warnings,
    };
  }

  private async load(state: State): Promise<Loaded> {
    const built = await loadRoomPolicies(this.opts.storage, state.parsed, {
      stateDir: this.opts.dataDir,
      modeEnums: ROOM_MODES,
      files: state.files,
    });
    return {
      state,
      table: built.table,
      warnings: [...state.fileWarnings, ...built.warnings],
    };
  }

  private entryExists(state: State, platform: string, selector: string): boolean {
    return (
      pairsFor(state.pairs, platform, selector).length > 0 ||
      fileFor(state.files, platform, selector) !== undefined
    );
  }

  private versionOf(state: State, platform: string, selector: string): string {
    const file = fileFor(state.files, platform, selector);
    return roomEntryVersion(pairsFor(state.pairs, platform, selector), file?.body ?? null);
  }

  private viewOf(loaded: Loaded, platform: string, selector: string): RoomEntryView {
    const { state } = loaded;
    const mine = pairsFor(state.pairs, platform, selector);
    const file = fileFor(state.files, platform, selector);
    const warnings: string[] = [];

    const check = checkRoomSelector(platform, selector, { allowNameMatching: true });
    if (check.ok) warnings.push(...check.warnings);
    else warnings.push(check.reason);

    // Raw values the operator wrote; the last line for a field wins, as in buildChannels.
    const raw = new Map<string, string>();
    for (const [k, v] of mine) {
      const line = parseChannelsLine(`${k}: ${v}`);
      if (line?.kind === 'entry') raw.set(line.field, parseConfigScalar(line.value));
    }
    const fields: RoomEntryView['fields'] = {};
    const skills = (raw.get('skills') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const kept = [...new Set(skills)].filter((s) => s.length <= 64).slice(0, 8);
    if (kept.length !== new Set(skills).size) {
      warnings.push('Only the first 8 skills of at most 64 characters are shown.');
    }
    if (kept.length > 0) fields.skills = kept;
    const model = raw.get('model');
    if (model) {
      if (model.length <= 200) fields.model = model;
      else warnings.push('The model value is longer than 200 characters and is not shown.');
    }
    const tier = raw.get('tier');
    if (tier !== undefined) {
      const t = TIERS.find((x) => x === tier);
      if (t === undefined) warnings.push(`tier '${tier}' is not one of ${TIERS.join(', ')}.`);
      else if (fields.model)
        warnings.push('model and tier are mutually exclusive; tier is ignored.');
      else fields.tier = t;
    }
    for (const f of ['identity', 'metadata', 'inherit', 'silent'] as const) {
      const v = raw.get(f);
      if (v === 'true') fields[f] = true;
      else if (v === 'false') fields[f] = false;
      else if (v !== undefined) warnings.push(`${f} '${v}' is not true or false.`);
    }
    const mode = raw.get('mode');
    if (mode !== undefined) {
      if (/^[a-z_]+$/.test(mode)) fields.mode = mode;
      else warnings.push(`mode '${mode}' is not a mode token.`);
    }

    const inline = raw.get('prompt');
    const prompt: RoomEntryView['prompt'] =
      inline !== undefined && inline !== ''
        ? { text: inline, chars: inline.length, source: 'config', path: null }
        : file !== undefined && file.body.trim() !== ''
          ? { text: file.body, chars: file.body.length, source: 'file', path: file.path }
          : { text: '', chars: 0, source: null, path: null };

    const names = [selector, normalisedRoomSelector(selector)];
    for (const w of loaded.warnings) {
      if (
        entryWarning(w, platform, names) ||
        (file !== undefined && w.startsWith(`${file.path}:`))
      ) {
        warnings.push(w);
      }
    }

    return {
      selector,
      kind: check.ok ? check.kind : 'room',
      fields,
      prompt,
      source: mine.length > 0 && file ? 'both' : file ? 'file' : 'config',
      version: roomEntryVersion(mine, file?.body ?? null),
      warnings: [...new Set(warnings)],
    };
  }

  async listRoomPolicies(input: { platform: RoomPlatform }) {
    const { platform } = input;
    const loaded = await this.load(await this.readState());
    const { state } = loaded;
    const selectors = selectorsOf(state.pairs, state.files, platform);
    const entries = selectors.map((s) => this.viewOf(loaded, platform, s));
    const attributed = (w: string) =>
      selectors.some((s) => entryWarning(w, platform, [s, normalisedRoomSelector(s)])) ||
      state.files.some((f) => f.platform === platform && w.startsWith(`${f.path}:`));
    const platformWarnings = loaded.warnings.filter(
      (w) =>
        !attributed(w) &&
        (w.startsWith(`channels.${platform}.`) || w.includes(`/channels/${platform}/`)),
    );
    const cfg = state.parsed.channels?.[platform];
    return {
      platform,
      allowNameMatching: cfg?.allowNameMatching === true,
      fetchMetadata: cfg?.fetchMetadata === true,
      modes: [...ROOM_MODES[platform]],
      entries,
      warnings: platformWarnings,
    };
  }

  // ---------------------------------------------------------------------
  // Validation (D5: the boot build is the validator)
  // ---------------------------------------------------------------------

  /**
   * Refuses what the boot build would drop for this selector and returns what it
   * would merely transform. Overlays the candidate entry (and its prompt file)
   * on the current sources and runs the same `loadRoomPolicies` boot runs.
   */
  private async validate(
    state: State,
    platform: RoomPlatform,
    selector: string,
    entry: RoomEntryFields,
  ): Promise<{ warnings: string[]; table: RoomPolicyTable | undefined }> {
    const check = checkRoomSelector(platform, selector, {
      allowNameMatching: state.parsed.channels?.[platform]?.allowNameMatching === true,
      existingSelectors: selectorsOf(state.pairs, state.files, platform),
    });
    if (!check.ok) throw invalid(check.reason, 'Use a room id the platform shows for the room.');
    const warnings = [...check.warnings];

    for (const [name, v] of [
      ['model', entry.model],
      ...(entry.skills ?? []).map((s) => ['skill', s]),
    ] as Array<[string, string | undefined]>) {
      if (v === undefined) continue;
      if (CONTROL_RE.test(v))
        throw invalid(`${name} '${v.slice(0, 40)}' contains a control character.`);
      if (name === 'skill' && (v.includes(',') || v.trim() !== v)) {
        throw invalid(`skill '${v}' cannot contain a comma or surrounding spaces.`);
      }
    }
    if (entry.model && entry.tier) throw invalid('model and tier are mutually exclusive.');

    const prompt = entry.prompt ?? '';
    if (Buffer.byteLength(prompt, 'utf-8') > PROMPT_MAX_BYTES) {
      throw new EthosError({
        code: 'PAYLOAD_TOO_LARGE',
        cause: `Prompt is ${Buffer.byteLength(prompt, 'utf-8')} bytes; the limit is 16 KiB.`,
        action: 'Shorten the prompt.',
      });
    }

    const path = roomPromptFilePath(this.opts.dataDir, platform, selector);
    const { prompt: _p, ...short } = entry;
    const current = state.parsed.channels?.[platform];
    const entries: Record<string, typeof short> = Object.create(null);
    for (const [k, v] of Object.entries(current?.entries ?? {})) {
      if (k !== selector) entries[k] = v;
    }
    if (Object.keys(short).length > 0) entries[selector] = short;
    const overlay: Pick<EthosConfig, 'channels' | 'modelRegistry'> = {
      channels: {
        ...(state.parsed.channels ?? {}),
        [platform]: { ...(current ?? {}), entries },
      },
      modelRegistry: state.parsed.modelRegistry,
    };
    const files = state.files.filter(
      (f) => !(f.platform === platform && fileSelector(f) === selector),
    );
    if (prompt.trim() !== '') {
      files.push({ platform, base: roomFileBase(selector), path, body: prompt });
    }
    const built = await loadRoomPolicies(this.opts.storage, overlay, {
      stateDir: this.opts.dataDir,
      modeEnums: ROOM_MODES,
      files,
    });

    const names = [selector, normalisedRoomSelector(selector)];
    const mine = built.warnings.filter(
      (w) => entryWarning(w, platform, names) || w.startsWith(`${path}:`),
    );
    const tooLong = mine.find((w) => /prompt rejected: (\d+) > \d+ chars/.test(w));
    if (tooLong) {
      const n = tooLong.match(/prompt rejected: (\d+)/)?.[1] ?? '?';
      throw new EthosError({
        code: 'PAYLOAD_TOO_LARGE',
        cause: `Prompt is ${Number(n).toLocaleString('en-US')} chars after template-token sanitising; the limit is ${PROMPT_MAX_CHARS.toLocaleString('en-US')}.`,
        action: 'Shorten the prompt. The editor never truncates.',
      });
    }
    const dropped = mine.find(dropsAField);
    if (dropped) throw invalid(dropped);
    warnings.push(...mine.filter((w) => !dropsAField(w)));

    const built1 = built.table?.[platform]?.entries[normalisedRoomSelector(selector)];
    if (prompt.trim() !== '' && built1?.prompt !== prompt) {
      warnings.push(
        `Template tokens in the prompt for '${selector}' are stripped when the gateway loads it; the saved file keeps what you typed.`,
      );
    }
    if (entry.metadata === true) {
      if (!METADATA_PLATFORMS.has(platform)) {
        warnings.push(`${platform} has no room metadata source, so metadata: true has no effect.`);
      } else if (state.parsed.channels?.[platform]?.fetchMetadata !== true) {
        warnings.push(
          'metadata is on, but Fetch room metadata is off for this platform, so no metadata is fetched.',
        );
      }
    }
    return { warnings, table: built.table };
  }

  // ---------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------

  private conflict(expected: string | null, current: string | null): EthosError {
    return new EthosError({
      code: 'CONFIG_CONFLICT',
      cause:
        expected === null
          ? 'This room already has an entry (it changed since the page loaded it).'
          : `Version '${expected}' is not current (${current === null ? 'the entry was removed' : `now '${current}'`}); another tab or the CLI changed it.`,
      action: 'Reload the entry and apply your change again.',
    });
  }

  /** Throws CONFIG_CONFLICT unless `expected` is current, or this is the retry of a partial write. */
  private checkVersion(
    state: State,
    platform: string,
    selector: string,
    expected: string | null,
    request: string,
  ): void {
    const exists = this.entryExists(state, platform, selector);
    const current = exists ? this.versionOf(state, platform, selector) : null;
    if (current === expected) return;
    const memo = this.pending.get(`${platform}\0${selector}`);
    const file = fileFor(state.files, platform, selector);
    if (
      memo &&
      memo.expected === expected &&
      memo.request === request &&
      memo.pairs === JSON.stringify(pairsFor(state.pairs, platform, selector)) &&
      memo.fileBody === (file?.body ?? null)
    ) {
      return;
    }
    throw this.conflict(expected, current);
  }

  private rewritePairs(
    current: readonly Pair[],
    drop: (p: Pair) => boolean,
    add: readonly Pair[],
  ): Pair[] {
    const at = current.findIndex(drop);
    const kept = current.filter((p) => !drop(p));
    const index = at < 0 ? kept.length : current.slice(0, at).filter((p) => !drop(p)).length;
    return [...kept.slice(0, index), ...add, ...kept.slice(index)];
  }

  async setRoomPolicy(input: {
    platform: RoomPlatform;
    selector: string;
    entry: RoomEntryFields;
    expectedVersion: string | null;
  }): Promise<SetRoomPolicyResult> {
    const { platform, selector, entry, expectedVersion } = input;
    return this.lock(async () => {
      const state = await this.readState();
      const { warnings } = await this.validate(state, platform, selector, entry);
      this.checkVersion(state, platform, selector, expectedVersion, JSON.stringify(entry));

      const path = roomPromptFilePath(this.opts.dataDir, platform, selector);
      const prompt = entry.prompt ?? '';
      const key = `${platform}\0${selector}`;
      const memo: Pending = {
        expected: expectedVersion,
        pairs: JSON.stringify(pairsFor(state.pairs, platform, selector)),
        fileBody: prompt.trim() === '' ? null : prompt,
        request: JSON.stringify(entry),
      };

      const add = this.linesFor(platform, selector, entry);
      // Defence in depth behind checkRoomSelector: every key written must parse
      // back (parseChannelsLine, the grammar owner) to this platform, selector
      // and field, or a hostile selector could re-route another entry's key.
      for (const [k, v] of add) {
        const line = parseChannelsLine(`${k}: ${v}`);
        const field = k.slice(`channels.${platform}.${selector}.`.length);
        if (
          line?.kind !== 'entry' ||
          line.platform !== platform ||
          line.selector !== selector ||
          line.field !== field
        ) {
          throw invalid(`Room id '${selector}' would be misread by the config parser.`);
        }
      }

      // 1. The prompt file first: until the config step lands, an old inline
      //    prompt still wins, so a failure here or below can never lose one.
      const { storage } = this.opts;
      let fileRemoved = false;
      if (prompt.trim() !== '') {
        await storage.mkdir(path.slice(0, path.lastIndexOf('/')));
        await storage.writeAtomic(path, prompt);
      } else if (await storage.exists(path)) {
        await storage.remove(path);
        fileRemoved = true;
      }

      // 2. The short fields, dropping every old line for the selector (the
      //    inline `.prompt` included, so the file is never shadowed).
      try {
        await this.opts.config.transform((current) => ({
          next: {
            ...current,
            channelLines: this.rewritePairs(
              current.channelLines ?? [],
              (p) => this.isEntryPair(p, platform, selector),
              add,
            ),
          },
          result: undefined,
        }));
      } catch (err) {
        this.pending.set(key, memo);
        return {
          ok: false as const,
          reason: 'partial' as const,
          fileWritten: prompt.trim() !== '',
          fileRemoved,
          configWritten: false,
          cause: `config.yaml write failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      this.pending.delete(key);

      const loaded = await this.load(await this.readState());
      return { ok: true as const, entry: this.viewOf(loaded, platform, selector), warnings };
    });
  }

  private isEntryPair(p: Pair, platform: string, selector: string): boolean {
    const line = parseChannelsLine(`${p[0]}: ${p[1]}`);
    return line?.kind === 'entry' && line.platform === platform && line.selector === selector;
  }

  private linesFor(platform: string, selector: string, e: RoomEntryFields): Pair[] {
    const k = (f: string) => `channels.${platform}.${selector}.${f}`;
    const out: Pair[] = [];
    if (e.skills && e.skills.length > 0) out.push([k('skills'), e.skills.join(',')]);
    if (e.model !== undefined) out.push([k('model'), renderConfigScalar(e.model)]);
    if (e.tier !== undefined) out.push([k('tier'), e.tier]);
    for (const f of ['identity', 'metadata', 'inherit', 'silent'] as const) {
      const v = e[f];
      if (v !== undefined) out.push([k(f), String(v)]);
    }
    if (e.mode !== undefined) out.push([k('mode'), e.mode]);
    return out;
  }

  async deleteRoomPolicy(input: {
    platform: RoomPlatform;
    selector: string;
    expectedVersion: string;
  }): Promise<DeleteRoomPolicyResult> {
    const { platform, selector, expectedVersion } = input;
    return this.lock(async () => {
      const state = await this.readState();
      if (!this.entryExists(state, platform, selector)) {
        this.pending.delete(`${platform}\0${selector}`);
        return { ok: true as const, removed: false };
      }
      this.checkVersion(state, platform, selector, expectedVersion, 'delete');

      const key = `${platform}\0${selector}`;
      const file = fileFor(state.files, platform, selector);
      const hadPairs = pairsFor(state.pairs, platform, selector).length > 0;
      const memo: Pending = {
        expected: expectedVersion,
        pairs: JSON.stringify(pairsFor(state.pairs, platform, selector)),
        fileBody: null,
        request: 'delete',
      };
      // `file.path` comes from the directory listing, not from the selector.
      if (file) await this.opts.storage.remove(file.path);
      try {
        if (hadPairs) {
          await this.opts.config.transform((current) => ({
            next: {
              ...current,
              channelLines: (current.channelLines ?? []).filter(
                (p) => !this.isEntryPair(p, platform, selector),
              ),
            },
            result: undefined,
          }));
        }
      } catch (err) {
        this.pending.set(key, memo);
        return {
          ok: false as const,
          reason: 'partial' as const,
          fileRemoved: file !== undefined,
          configRemoved: false,
          cause: `config.yaml write failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      this.pending.delete(key);
      return { ok: true as const, removed: true };
    });
  }

  async setRoomPlatformSettings(input: { platform: RoomPlatform; fetchMetadata: boolean }) {
    const { platform, fetchMetadata } = input;
    if (!METADATA_PLATFORMS.has(platform)) {
      return {
        ok: false as const,
        reason: 'unsupported' as const,
        cause: `${platform} has no room metadata source, so there is nothing to fetch.`,
      };
    }
    return this.lock(async () => {
      const isKnob = (p: Pair) => {
        const line = parseChannelsLine(`${p[0]}: ${p[1]}`);
        return (
          line?.kind === 'knob' && line.platform === platform && line.field === 'fetch_metadata'
        );
      };
      try {
        await this.opts.config.transform((current) => ({
          next: {
            ...current,
            channelLines: this.rewritePairs(current.channelLines ?? [], isKnob, [
              [`channels.${platform}.fetch_metadata`, String(fetchMetadata)],
            ]),
          },
          result: undefined,
        }));
      } catch (err) {
        return {
          ok: false as const,
          reason: 'partial' as const,
          cause: `config.yaml write failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return { ok: true as const, fetchMetadata };
    });
  }

  // ---------------------------------------------------------------------
  // Preview and recent rooms
  // ---------------------------------------------------------------------

  /** `ethos channels resolve --json`, field for field; `draft` is overlaid for this call only. */
  async previewRoomPolicy(input: {
    platform: RoomPlatform;
    chatId: string;
    threadId?: string | undefined;
    isDm: boolean;
    roomName?: string | undefined;
    draft?: { selector: string; entry: RoomEntryFields } | undefined;
  }): Promise<PreviewJson> {
    const state = await this.readState();
    let table: RoomPolicyTable | undefined;
    let warnings: string[];
    if (input.draft) {
      const checked = await this.validate(
        state,
        input.platform,
        input.draft.selector,
        input.draft.entry,
      );
      table = checked.table;
      warnings = [...state.fileWarnings, ...checked.warnings];
    } else {
      const loaded = await this.load(state);
      table = loaded.table;
      warnings = loaded.warnings;
    }
    const resolveInput = {
      platform: input.platform,
      chatId: input.chatId,
      isDm: input.isDm,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.roomName ? { roomName: input.roomName } : {}),
    };
    return previewRoomPolicyJson(table ?? {}, resolveInput, warnings);
  }

  /** Rooms (never threads, D19) the platform's lanes ran in. Ids, DM flag and time only. */
  async listRecentRooms(input: { platform: RoomPlatform; limit?: number | undefined }) {
    const limit = input.limit ?? RECENT_DEFAULT;
    const [sessions, state] = await Promise.all([
      this.opts.sessions.listSessions({
        keyPrefix: `${encodeURIComponent(input.platform)}:`,
        limit: RECENT_SCAN,
      }),
      this.readState(),
    ]);
    const newest = new Map<string, { at: Date; isDm: boolean | null; dmAt: Date | null }>();
    for (const s of sessions) {
      if (isIncognitoSession(s)) continue;
      const chatId = laneKeyChatId(s.key);
      if (chatId === undefined) continue;
      const seen = newest.get(chatId) ?? { at: s.updatedAt, isDm: null, dmAt: null };
      if (s.updatedAt > seen.at) seen.at = s.updatedAt;
      // DM-ness comes from the newest session of the room that recorded it
      // (a thread or `/new` lane may not have).
      const dm = s.metadata?.[IS_DM_KEY];
      if (typeof dm === 'boolean' && (seen.dmAt === null || s.updatedAt > seen.dmAt)) {
        seen.isDm = dm;
        seen.dmAt = s.updatedAt;
      }
      newest.set(chatId, seen);
    }
    const have = new Set(selectorsOf(state.pairs, state.files, input.platform));
    const rooms = [...newest.entries()]
      .sort((a, b) => b[1].at.getTime() - a[1].at.getTime())
      .map(([chatId, v]) => ({
        chatId,
        isDm: v.isDm,
        lastActiveAt: v.at.toISOString(),
        hasEntry: have.has(chatId),
      }));
    return { rooms: rooms.slice(0, limit), omittedCount: Math.max(0, rooms.length - limit) };
  }
}
