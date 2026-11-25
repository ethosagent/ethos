import { z } from 'zod';

// ---------------------------------------------------------------------------
// Communications — v1
//
// Per-platform connection state. The web tab edits four platforms by
// writing the same flat keys the gateway already reads from
// ~/.ethos/config.yaml (telegramToken, slackBotToken, …). Sensitive
// values never cross the wire on read; only `configured: boolean` is
// emitted. The setup form posts plaintext on update, then the read
// flips to configured = true.
// ---------------------------------------------------------------------------

export const PlatformIdSchema = z.enum(['telegram', 'discord', 'slack', 'email', 'whatsapp']);
export type PlatformId = z.infer<typeof PlatformIdSchema>;

export const PlatformStatusSchema = z.object({
  id: PlatformIdSchema,
  /** True when every required secret field has a non-empty value. */
  configured: z.boolean(),
  /** Per-field configured-ness so the form can show partial state. */
  fields: z.record(z.string(), z.boolean()),
});
export type PlatformStatus = z.infer<typeof PlatformStatusSchema>;

// ---------------------------------------------------------------------------
// Multi-bot routing — per-entry shapes for telegram.bots[] / slack.apps[]
// ---------------------------------------------------------------------------

export const BotBindingSchema = z.object({
  type: z.enum(['personality', 'team']),
  name: z.string(),
});
export type BotBinding = z.infer<typeof BotBindingSchema>;

export const TelegramBotEntrySchema = z.object({
  /** Stable identifier derived from token sha256 or explicit `id` field. */
  botKey: z.string(),
  /** True when the token is stored in config (tokens never cross the wire). */
  tokenConfigured: z.boolean(),
  username: z.string().optional(),
  bind: BotBindingSchema,
});
export type TelegramBotEntry = z.infer<typeof TelegramBotEntrySchema>;

export const SlackAppEntrySchema = z.object({
  botKey: z.string(),
  botTokenConfigured: z.boolean(),
  appTokenConfigured: z.boolean(),
  signingSecretConfigured: z.boolean(),
  bind: BotBindingSchema,
});
export type SlackAppEntry = z.infer<typeof SlackAppEntrySchema>;

// WhatsApp pairs via QR code, not a config-form token — an entry is routing
// knobs + a `paired` flag derived from whether the Baileys session dir on disk
// holds saved credentials. Saving a bot requires a `bind` (see the
// botsAddWhatsApp router input), but `bind` is optional on the entry so that
// listing a legacy bind-less config doesn't throw.
/**
 * Every mode the WhatsApp adapter's own enum accepts
 * (`extensions/platform-whatsapp/src/config.ts`). `observe` records the room
 * and never replies in it, not even to an @mention.
 *
 * It is spelled out here, and matched against the adapter's list by a test,
 * because the previous two-value version did not fail — it DISPLAYED. An
 * observe-configured bot came back over the wire as `mention_only` and the
 * Platforms table drew a bot that answers mentions, which is the opposite of
 * what the operator configured.
 */
export const WhatsAppChannelModeSchema = z.enum(['all', 'mention_only', 'observe']);
export type WhatsAppChannelMode = z.infer<typeof WhatsAppChannelModeSchema>;

export const WhatsAppEntrySchema = z.object({
  botKey: z.string(),
  defaultMode: WhatsAppChannelModeSchema,
  allowedNumbers: z.array(z.string()),
  /** Phone number this bot links via pairing code, when configured. Absent for
   *  QR-linked bots. Lets the UI show which number is being paired. */
  phoneNumber: z.string().optional(),
  /** True when the Baileys session dir for this bot is non-empty (QR pairing
   *  completed and credentials were persisted). */
  paired: z.boolean(),
  /** Personality/team this bot routes to. Required when saving via
   *  botsAddWhatsApp; optional here so legacy bind-less configs still list. */
  bind: BotBindingSchema.optional(),
});
export type WhatsAppEntry = z.infer<typeof WhatsAppEntrySchema>;

export const ChannelPlatformFilterSchema = z.object({
  enabled: z.boolean(),
  ownerUserId: z.string(),
  allowlist: z.array(z.string()),
});
export type ChannelPlatformFilter = z.infer<typeof ChannelPlatformFilterSchema>;

// ---------------------------------------------------------------------------
// Per-room policy (channels.<platform>.<selector>.* + channels/<platform>/<base>.md)
//
// Backed by the gateway's room-policy table. Selector grammar, per-platform id
// shape and mode validity are enforced server-side (RoomPolicyService, D5/D15);
// these schemas pin only the wire shape and the caps that map to a distinct
// status code. Server codes: INVALID_INPUT 400, CONFIG_CONFLICT 409,
// PAYLOAD_TOO_LARGE 413 (4,000 chars after template-token sanitising, or 16 KiB).
// ---------------------------------------------------------------------------

export const RoomPlatformSchema = z.enum(['slack', 'discord', 'telegram', 'whatsapp']);
export type RoomPlatform = z.infer<typeof RoomPlatformSchema>;

/**
 * Reply modes a room entry may name, per platform. A hand-kept mirror of each
 * adapter's `CHANNEL_MODES` (web-contracts cannot import the platform
 * packages); `apps/web-api/src/__tests__/room-mode-enum-drift.test.ts` pins
 * every list to the adapter's own. Telegram keeps `regex_match` for display
 * only: the server refuses it in a room entry (it needs a runtime pattern).
 */
export const ROOM_MODES = {
  slack: ['mention_only', 'thread_follow', 'all', 'observe'],
  discord: ['mention_only', 'thread_follow', 'all', 'observe'],
  telegram: ['mention_only', 'thread_follow', 'all', 'regex_match', 'observe'],
  whatsapp: ['all', 'mention_only', 'observe'],
} as const satisfies Record<RoomPlatform, readonly string[]>;

/** The room fields without the model/tier exclusivity refinement (zod 4 cannot
 *  `.omit` a refined object, and `RoomEntryView.fields` excludes `prompt`). */
const RoomEntryFieldsBase = z.object({
  /** Bytes re-checked server-side: 4,000 chars post-sanitise, 16 KiB (413). */
  prompt: z.string().max(16_384).optional(),
  skills: z.array(z.string().min(1).max(64)).max(8).optional(),
  model: z.string().min(1).max(200).optional(),
  tier: z.enum(['trivial', 'default', 'deep', 'dreaming']).optional(),
  identity: z.boolean().optional(),
  metadata: z.boolean().optional(),
  inherit: z.boolean().optional(),
  silent: z.boolean().optional(),
  /** Validity per platform is checked server-side against `ROOM_MODES[platform]`. */
  mode: z
    .string()
    .regex(/^[a-z_]+$/)
    .optional(),
});

const modelTierExclusive = (e: { model?: string | undefined; tier?: string | undefined }) =>
  !(e.model && e.tier);
const MODEL_TIER_MESSAGE = 'model and tier are mutually exclusive';

export const RoomEntryFieldsSchema = RoomEntryFieldsBase.refine(
  modelTierExclusive,
  MODEL_TIER_MESSAGE,
);
export type RoomEntryFields = z.infer<typeof RoomEntryFieldsSchema>;

/** Grammar (path safety, wildcards, topics, `name:`) is enforced server-side. */
export const RoomSelectorSchema = z.string().min(1).max(160);

export const RoomEntryKindSchema = z.enum(['rooms', 'dms', 'room', 'topic', 'name']);

export const RoomEntryViewSchema = z.object({
  selector: z.string(),
  kind: RoomEntryKindSchema,
  /** The raw values the operator wrote, `prompt` excluded. */
  fields: RoomEntryFieldsBase.omit({ prompt: true }).refine(modelTierExclusive, MODEL_TIER_MESSAGE),
  prompt: z.object({
    text: z.string(),
    chars: z.number().int().nonnegative(),
    source: z.enum(['file', 'config']).nullable(),
    path: z.string().nullable(),
  }),
  source: z.enum(['config', 'file', 'both']),
  version: z.string(),
  warnings: z.array(z.string()),
});
export type RoomEntryView = z.infer<typeof RoomEntryViewSchema>;

export const ListRoomPoliciesInputSchema = z.object({ platform: RoomPlatformSchema });
export const ListRoomPoliciesOutputSchema = z.object({
  platform: RoomPlatformSchema,
  allowNameMatching: z.boolean(),
  fetchMetadata: z.boolean(),
  modes: z.array(z.string()),
  entries: z.array(RoomEntryViewSchema),
  warnings: z.array(z.string()),
});

export const SetRoomPolicyInputSchema = z.object({
  platform: RoomPlatformSchema,
  selector: RoomSelectorSchema,
  entry: RoomEntryFieldsSchema,
  /** `null` means "the selector must not exist yet". */
  expectedVersion: z.string().nullable(),
});
export const SetRoomPolicyOutputSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    entry: RoomEntryViewSchema,
    warnings: z.array(z.string()),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.literal('partial'),
    fileWritten: z.boolean(),
    /** A blank prompt deleted the existing prompt file before config.yaml failed. */
    fileRemoved: z.boolean(),
    configWritten: z.boolean(),
    cause: z.string(),
  }),
]);

export const DeleteRoomPolicyInputSchema = z.object({
  platform: RoomPlatformSchema,
  selector: RoomSelectorSchema,
  expectedVersion: z.string(),
});
export const DeleteRoomPolicyOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), removed: z.boolean() }),
  z.object({
    ok: z.literal(false),
    reason: z.literal('partial'),
    fileRemoved: z.boolean(),
    configRemoved: z.boolean(),
    cause: z.string(),
  }),
]);

export const PreviewRoomPolicyInputSchema = z.object({
  platform: RoomPlatformSchema,
  chatId: z.string().min(1).max(160),
  threadId: z.string().min(1).max(160).optional(),
  isDm: z.boolean(),
  roomName: z.string().max(200).optional(),
  /** Overlaid on the current table for this preview only; never written. */
  draft: z.object({ selector: RoomSelectorSchema, entry: RoomEntryFieldsSchema }).optional(),
});
/** Field for field the `ethos channels resolve --json` object. */
export const PreviewRoomPolicyOutputSchema = z.object({
  ok: z.literal(true),
  platform: z.string(),
  chatId: z.string(),
  threadId: z.string().nullable(),
  isDm: z.boolean(),
  roomName: z.string().nullable(),
  match: z.object({
    key: z.string().nullable(),
    source: z.enum(['topic', 'direct', 'parent', 'name', 'wildcard', 'none']),
    layers: z.array(z.string()),
  }),
  fields: z.object({
    skills: z.array(z.string()).nullable(),
    model: z.string().nullable(),
    tier: z.string().nullable(),
    identity: z.boolean(),
    metadata: z.boolean(),
    silent: z.boolean(),
    mode: z.string().nullable(),
    modeKey: z.string().nullable(),
  }),
  promptLayers: z.array(z.object({ key: z.string(), chars: z.number().int().nonnegative() })),
  digest: z.string().nullable(),
  block: z.string().nullable(),
  identityLineOmitted: z.boolean(),
  warnings: z.array(z.string()),
});

export const ListRecentRoomsInputSchema = z.object({
  platform: RoomPlatformSchema,
  /** Default 25 (server-side). */
  limit: z.number().int().min(1).max(50).optional(),
});
export const ListRecentRoomsOutputSchema = z.object({
  rooms: z.array(
    z.object({
      chatId: z.string(),
      /** `null` when no session metadata says whether the room is a DM. */
      isDm: z.boolean().nullable(),
      lastActiveAt: z.string(),
      hasEntry: z.boolean(),
    }),
  ),
  omittedCount: z.number().int().nonnegative(),
});

export const SetRoomPlatformSettingsInputSchema = z.object({
  platform: RoomPlatformSchema,
  fetchMetadata: z.boolean(),
});
export const SetRoomPlatformSettingsOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), fetchMetadata: z.boolean() }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['partial', 'unsupported']),
    cause: z.string(),
  }),
]);
