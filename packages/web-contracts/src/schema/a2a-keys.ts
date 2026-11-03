import { z } from 'zod';

// ---------------------------------------------------------------------------
// A2A peering (admin surface)
//
// Wire mirrors of `A2aPeerRow` / `A2aIdentityView` from `@ethosagent/wiring`.
// The A2A admin RPC (`a2a.*`) rides the same cookie/bearer `/rpc` auth as the
// other management namespaces — distinct from the peer-facing `/a2a` endpoints.
// `access` is the literal `'full'` in v1 (scope `['*']`, plan §2a).
// ---------------------------------------------------------------------------

export const A2aPeerRowSchema = z.object({
  fingerprint: z.string(),
  /** Local display name (from the allowlist entry). */
  label: z.string().optional(),
  /** The peer's self-reported name (from the peer store card). */
  cardName: z.string().optional(),
  /** The peer's well-known URL (from the allowlist entry). */
  url: z.string().optional(),
  /** v1 always full access, bounded by the owner's exposed skills. */
  access: z.literal('full'),
  enabled: z.boolean(),
  /** ms epoch of the last inbound authenticated interaction; absent → never. */
  lastSeenAt: z.number().optional(),
});
export type A2aPeerRowWire = z.infer<typeof A2aPeerRowSchema>;

export const A2aIdentityViewSchema = z.object({
  personalityId: z.string(),
  name: z.string(),
  fingerprint: z.string(),
  wellKnownUrl: z.string(),
  jsonRpcUrl: z.string(),
  authUrl: z.string(),
  did: z.string().optional(),
  exposedSkills: z.array(z.string()),
});
export type A2aIdentityViewWire = z.infer<typeof A2aIdentityViewSchema>;

// ---------------------------------------------------------------------------
// Keys — the canonical category list
//
// THE single definition of the Keys-pane categories, in display order. It lives
// here because it is the one thing both sides of the wire must agree on, and
// both already import this package: `apps/web-api` (the catalog's `KeyCategory`
// and the order `KeysService.list()` emits) and `apps/web` (the settings
// taxonomy, the settings index, and the pane's own headings). Adding or
// renaming a category is a one-line edit here; everything else derives.
// ---------------------------------------------------------------------------

export const KEY_CATEGORY_IDS = [
  'tools',
  'voice',
  'gateway',
  'settings',
  'connections',
  'custom',
] as const;

export type KeyCategoryId = (typeof KEY_CATEGORY_IDS)[number];

export const KeyCategorySchema = z.enum(KEY_CATEGORY_IDS);
