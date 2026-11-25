import {
  ROOM_MODES,
  type RoomEntryFields,
  type RoomEntryView,
  type RoomPlatform,
} from '@ethosagent/web-contracts';

// View logic for Communications > Rooms (plan/phases/channel-prompts-ui.md L5).
//
// Pure, so every row, chip, counter and form mapping is pinned in
// `__tests__/room-rows.test.ts` without rendering antd. Nothing here is a
// security control: the path-safety checks in `checkRoomId` mirror
// `checkRoomSelector` (packages/wiring/src/room-policy.ts) only so the drawer
// can answer while the operator types. The server re-checks every write.

/** The prompt cap the gateway enforces after template-token sanitising
 *  (apps/web-api/src/services/room-policy.service.ts, PROMPT_MAX_CHARS). The
 *  counter counts what was typed; a sanitising difference surfaces as a 413. */
export const PROMPT_LIMIT = 4000;

export const TIERS = ['trivial', 'default', 'deep', 'dreaming'] as const;

const PLATFORM_LABELS: Record<RoomPlatform, string> = {
  slack: 'Slack',
  discord: 'Discord',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
};

export function platformLabel(platform: RoomPlatform): string {
  return PLATFORM_LABELS[platform];
}

/** Slack and Discord have channels; Telegram and WhatsApp have groups. */
export function roomNoun(platform: RoomPlatform): 'channel' | 'group' {
  return platform === 'slack' || platform === 'discord' ? 'channel' : 'group';
}

/** Only Slack and Discord have a metadata source (backend §3.2: `unsupported`). */
export function hasMetadataSource(platform: RoomPlatform): boolean {
  return platform === 'slack' || platform === 'discord';
}

export const ROOM_ID_HINTS: Record<RoomPlatform, string> = {
  slack:
    'Open the channel, click its name, then About. The Channel ID is at the bottom (starts with C or G).',
  discord:
    'Settings, Advanced, Developer Mode on, then right-click the channel and Copy Channel ID. A thread: right-click the thread and Copy Thread ID.',
  telegram: 'A group id starts with -100. Topic ids are in the topic link (t.me/c/…/<topic>).',
  whatsapp: 'Group ids end in @g.us.',
};

/** Slack's slash command is namespaced; the others use `/channel`. */
export function channelCommand(platform: RoomPlatform): string {
  return platform === 'slack' ? '/ethos channel' : '/channel';
}

export const ROOM_MODE_DESCRIPTIONS: Record<string, string> = {
  mention_only: 'Answers only when @-mentioned.',
  thread_follow: 'After one mention, keeps answering in that thread.',
  all: 'Answers every message.',
  observe: 'Reads, never answers (digest only).',
  regex_match: 'Needs a pattern. Set it at runtime with the channel-mode command.',
};

/** The server's own sentence for `regex_match` in a room entry (plan §3.3). */
export const REGEX_MATCH_REFUSAL =
  'regex_match needs a pattern. Set it at runtime with the channel-mode command.';

/** Modes a room entry may name: the platform list, minus `regex_match`, which
 *  the server refuses in an entry (it needs a runtime pattern). */
export function selectableModes(platform: RoomPlatform): readonly string[] {
  return ROOM_MODES[platform].filter((m) => m !== 'regex_match');
}

// -- Rows ---------------------------------------------------------------------

export interface RoomRow {
  key: string;
  selector: string;
  /** Human label; only the pinned rows have one. */
  label: string | null;
  pinned: boolean;
  /** A `.topics.` entry sits right under its room. */
  indent: boolean;
  entry: RoomEntryView | null;
}

export function pinnedLabel(platform: RoomPlatform, selector: '*' | '*dm'): string {
  if (selector === '*dm') return 'All DMs';
  return roomNoun(platform) === 'channel' ? 'All channels' : 'All groups';
}

export function buildRows(platform: RoomPlatform, entries: readonly RoomEntryView[]): RoomRow[] {
  const bySelector = new Map(entries.map((e) => [e.selector, e] as const));
  const pinned: RoomRow[] = (['*', '*dm'] as const).map((selector) => ({
    key: selector,
    selector,
    label: pinnedLabel(platform, selector),
    pinned: true,
    indent: false,
    entry: bySelector.get(selector) ?? null,
  }));
  const rest = entries
    .filter((e) => e.selector !== '*' && e.selector !== '*dm')
    .sort((a, b) => (a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0))
    .map<RoomRow>((entry) => ({
      key: entry.selector,
      selector: entry.selector,
      label: null,
      pinned: false,
      indent: entry.kind === 'topic',
      entry,
    }));
  return [...pinned, ...rest];
}

export interface Chip {
  text: string;
  tone: 'mode' | 'silent' | 'plain' | 'none';
}

export function rowChips(entry: RoomEntryView | null): Chip[] {
  if (!entry) return [{ text: 'not set', tone: 'none' }];
  const f = entry.fields;
  const chips: Chip[] = [];
  if (f.mode) chips.push({ text: f.mode, tone: 'mode' });
  if (f.silent) chips.push({ text: 'silent', tone: 'silent' });
  for (const s of f.skills ?? []) chips.push({ text: s, tone: 'plain' });
  if (f.model) chips.push({ text: `model: ${f.model}`, tone: 'plain' });
  if (f.tier) chips.push({ text: `tier: ${f.tier}`, tone: 'plain' });
  return chips.length > 0 ? chips : [{ text: 'prompt only', tone: 'none' }];
}

export function sourceLabel(entry: RoomEntryView | null): string {
  if (!entry) return 'none';
  return entry.source === 'both' ? 'file + config' : entry.source;
}

export function promptCounter(chars: number): { text: string; over: boolean; overBy: number } {
  const over = chars > PROMPT_LIMIT;
  return {
    text: `${chars.toLocaleString('en-US')} / ${PROMPT_LIMIT.toLocaleString('en-US')}`,
    over,
    overBy: over ? chars - PROMPT_LIMIT : 0,
  };
}

/** The prompt file a selector lives in, for the delete note. Display only: the
 *  server owns the real mapping (`roomFileBase`, packages/wiring). */
export function roomFileName(platform: RoomPlatform, selector: string): string {
  const base =
    selector === '*'
      ? '_rooms'
      : selector === '*dm'
        ? '_dms'
        : selector.startsWith('name:')
          ? `name_${selector.slice('name:'.length)}`
          : selector;
  return `channels/${platform}/${base}.md`;
}

// -- Client-side id check -----------------------------------------------------

const SHAPES: Record<RoomPlatform, { re: RegExp; noun: string; example: string }> = {
  slack: { re: /^[A-Z0-9]{2,32}$/, noun: 'Slack channel id', example: 'C0123ABCDEF' },
  discord: { re: /^\d{5,25}$/, noun: 'Discord channel id', example: '123456789012345678' },
  telegram: { re: /^-?\d{1,20}$/, noun: 'Telegram chat id', example: '-1001234567890' },
  whatsapp: {
    re: /^[0-9]{5,32}(-[0-9]+)?@(g\.us|s\.whatsapp\.net|lid)$/,
    noun: 'WhatsApp group id',
    example: '120363012345678901@g.us',
  },
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

export interface IdCheck {
  error: string | null;
  warning: string | null;
}

export function checkRoomId(platform: RoomPlatform, selector: string): IdCheck {
  const none: IdCheck = { error: null, warning: null };
  if (selector === '') return none;
  const refuse = (error: string): IdCheck => ({ error, warning: null });
  if (/[/\\]/.test(selector)) {
    return refuse(
      `Room ids cannot contain '/' or '\\'. Refused: it would write outside channels/${platform}/.`,
    );
  }
  if (CONTROL_RE.test(selector)) return refuse('Room ids cannot contain control characters.');
  if (/\s/.test(selector)) return refuse('Room ids cannot contain whitespace.');
  if (selector !== '*' && selector !== '*dm' && /[*?<>|"]/.test(selector)) {
    return refuse(`Room ids cannot contain any of * ? < > | " (only '*' and '*dm' are wildcards).`);
  }
  if ((selector.startsWith('name:') ? selector.slice(5) : selector).includes(':')) {
    return refuse("Room ids cannot contain ':' (only the 'name:' prefix may).");
  }
  if (selector.includes('..') || selector.startsWith('.')) {
    return refuse("Room ids cannot contain '..' or start with '.'.");
  }
  if (selector.startsWith('_') || selector.startsWith('name_')) {
    return refuse("Room ids cannot start with '_' or 'name_'.");
  }
  if (selector.length > 160) return refuse('Room ids are at most 160 characters.');
  if (selector === '*' || selector === '*dm' || selector.startsWith('name:')) return none;

  const room = selector.split('.topics.')[0] ?? selector;
  const shape = SHAPES[platform];
  if (!shape.re.test(room)) {
    return {
      error: null,
      warning: `'${room}' does not look like a ${shape.noun} (for example ${shape.example}). It is path-safe, so you can still save it.`,
    };
  }
  return none;
}

// -- Drawer form --------------------------------------------------------------

export interface RoomForm {
  /** The whole selector when editing; the room id when adding. */
  roomId: string;
  /** Telegram only. */
  topicId: string;
  /** Discord only: a thread's own id, written as the direct key (plan D20). */
  threadId: string;
  prompt: string;
  skills: string[];
  mode: string;
  /** '' | `alias:<name>` | `tier:<tier>`: one value, so model and tier cannot both be set. */
  model: string;
  /** Booleans stay `undefined` until the operator touches them, so an
   *  untouched switch writes nothing and the gateway default applies. */
  silent: boolean | undefined;
  identity: boolean | undefined;
  metadata: boolean | undefined;
  inherit: boolean | undefined;
}

export function emptyForm(): RoomForm {
  return {
    roomId: '',
    topicId: '',
    threadId: '',
    prompt: '',
    skills: [],
    mode: '',
    model: '',
    silent: undefined,
    identity: undefined,
    metadata: undefined,
    inherit: undefined,
  };
}

/** Gateway defaults a switch shows when the entry does not say (room-policy.ts). */
export const SWITCH_DEFAULTS = { silent: false, identity: true, metadata: false, inherit: true };

export function formFromEntry(entry: RoomEntryView): RoomForm {
  const f = entry.fields;
  return {
    ...emptyForm(),
    roomId: entry.selector,
    prompt: entry.prompt.text,
    skills: [...(f.skills ?? [])],
    mode: f.mode ?? '',
    model: f.tier ? `tier:${f.tier}` : f.model ? `alias:${f.model}` : '',
    silent: f.silent,
    identity: f.identity,
    metadata: f.metadata,
    inherit: f.inherit,
  };
}

export function selectorFromForm(platform: RoomPlatform, form: RoomForm): string {
  const room = form.roomId.trim();
  if (platform === 'telegram' && form.topicId.trim() !== '') {
    return `${room}.topics.${form.topicId.trim()}`;
  }
  if (platform === 'discord' && form.threadId.trim() !== '') return form.threadId.trim();
  return room;
}

function isTier(v: string): v is (typeof TIERS)[number] {
  return TIERS.some((t) => t === v);
}

export function entryFromForm(form: RoomForm): RoomEntryFields {
  const entry: RoomEntryFields = { prompt: form.prompt };
  if (form.skills.length > 0) entry.skills = form.skills;
  if (form.mode !== '') entry.mode = form.mode;
  if (form.model.startsWith('tier:')) {
    const tier = form.model.slice('tier:'.length);
    if (isTier(tier)) entry.tier = tier;
  } else if (form.model.startsWith('alias:')) {
    const alias = form.model.slice('alias:'.length);
    if (alias !== '') entry.model = alias;
  }
  if (form.silent !== undefined) entry.silent = form.silent;
  if (form.identity !== undefined) entry.identity = form.identity;
  if (form.metadata !== undefined) entry.metadata = form.metadata;
  if (form.inherit !== undefined) entry.inherit = form.inherit;
  return entry;
}

export interface PreviewInput {
  platform: RoomPlatform;
  chatId: string;
  threadId?: string;
  isDm: boolean;
  roomName?: string;
  draft: { selector: string; entry: RoomEntryFields };
}

/** The `previewRoomPolicy` input for the unsaved form, or null while there is
 *  no selector to preview. A wildcard has no real room, so it previews against
 *  a stand-in id. */
export function previewInputFor(
  platform: RoomPlatform,
  form: RoomForm,
  isDm: boolean,
): PreviewInput | null {
  const selector = selectorFromForm(platform, form);
  if (selector === '') return null;
  const draft = { selector, entry: entryFromForm(form) };
  if (selector === '*') return { platform, chatId: 'preview-room', isDm, draft };
  if (selector === '*dm') return { platform, chatId: 'preview-dm', isDm: true, draft };
  if (selector.startsWith('name:')) {
    return {
      platform,
      chatId: 'preview-room',
      isDm,
      roomName: selector.slice('name:'.length),
      draft,
    };
  }
  const at = selector.indexOf('.topics.');
  if (at >= 0) {
    const threadId = selector.slice(at + '.topics.'.length);
    const chatId = selector.slice(0, at);
    if (chatId !== '' && threadId !== '') return { platform, chatId, threadId, isDm, draft };
  }
  return { platform, chatId: selector, isDm, draft };
}
