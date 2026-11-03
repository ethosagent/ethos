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
