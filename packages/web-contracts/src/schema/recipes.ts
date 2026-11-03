import { z } from 'zod';
import { MissedRunPolicySchema } from './cron';

// ---------------------------------------------------------------------------
// Recipes — one-click use-case bundles (plan/phases/recipes-gallery.md §2/§4)
//
// The bundle data and its authoring schema live in `@ethosagent/recipes`, an
// extension. These shapes MIRROR `RecipeBundleSchema` there, the same way
// `McpRemotePresetSchema` mirrors `McpRemotePreset` in `@ethosagent/tools-mcp`:
// this package is imported by the browser and sits below the extensions layer,
// so it describes the wire and imports nothing. The mirror is kept honest by a
// test that parses every shipped bundle through these schemas
// (`apps/web-api/src/__tests__/services/recipes.test.ts`).
// ---------------------------------------------------------------------------

/** What a recipe still needs from the user before it can be installed. */
export const RecipeInputKindSchema = z.enum([
  'text',
  'secret',
  'path',
  'choice',
  'cron',
  'chatTarget',
]);
export type RecipeInputKind = z.infer<typeof RecipeInputKindSchema>;

export const RecipeInputSchema = z.object({
  key: z.string(),
  label: z.string(),
  kind: RecipeInputKindSchema,
  required: z.boolean(),
  default: z.string().optional(),
  placeholder: z.string().optional(),
  options: z.array(z.string()).optional(),
  help: z.string(),
});

const RecipeModelTierSchema = z.object({
  trivial: z.string().optional(),
  default: z.string().optional(),
  deep: z.string().optional(),
  dreaming: z.string().optional(),
});

const RecipeFsReachSchema = z.object({
  read: z.array(z.string()).optional(),
  write: z.array(z.string()).optional(),
  workdir: z.union([z.string(), z.array(z.string())]).optional(),
});

/** Mirrors the bundle's `safety.network` — declared reach, not a new capability. */
const RecipeNetworkPolicySchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  allow_private_urls: z.boolean().optional(),
});

/** The create-side fields — the recipe writes a new personality. */
const RecipeCreateFields = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** May still contain `{{input.*}}` — this is the bundle, not the install. */
  soulMd: z.string(),
  model: z.union([z.string(), RecipeModelTierSchema]).optional(),
  provider: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  toolset: z.array(z.string()),
  mcpServers: z.array(z.string()).optional(),
  plugins: z.array(z.string()).optional(),
  fsReach: RecipeFsReachSchema.optional(),
  /**
   * Declared network reach. ABSENT means the installer applies `allow: ['*']`
   * (recipes-gallery D15) — absent is not "no policy", it is an empty allowlist
   * that denies every host.
   */
  safety: z.object({ network: RecipeNetworkPolicySchema }).optional(),
});

/**
 * The attach-side fields — the recipe installs ONTO an existing personality,
 * chosen at install time as `personalityIdOverride`. Additive only: a marked
 * SOUL section, tools unioned into the toolset, reach entries appended. No id,
 * name, model or network policy — those stay the target's.
 */
const RecipeAttachFields = z.object({
  /** May still contain `{{input.*}}`. */
  soulSection: z.string(),
  toolset: z.array(z.string()),
  mcpServers: z.array(z.string()).optional(),
  plugins: z.array(z.string()).optional(),
  fsReach: z
    .object({ read: z.array(z.string()).optional(), write: z.array(z.string()).optional() })
    .optional(),
});

/**
 * Three modes. `create` and `attach` are one view each; `both` carries the
 * create view at the top level and the attach view under `attach`, and the
 * install picks one with `installMode` (default `create`).
 */
export const RecipePersonalitySchema = z.discriminatedUnion('mode', [
  RecipeCreateFields.extend({ mode: z.literal('create') }),
  RecipeAttachFields.extend({ mode: z.literal('attach') }),
  RecipeCreateFields.extend({ mode: z.literal('both'), attach: RecipeAttachFields }),
]);

/** Which view of a `both` recipe an install runs. Ignored for single-mode recipes. */
export const RecipeInstallModeSchema = z.enum(['create', 'attach']);
export type RecipeInstallMode = z.infer<typeof RecipeInstallModeSchema>;

export const RecipeRequirementsSchema = z.object({
  mcpServers: z.array(
    z.object({
      name: z.string(),
      catalogId: z.string().optional(),
      transport: z.enum(['stdio', 'streamable-http', 'sse']),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
      envKeys: z.array(z.string()).optional(),
      auth: z.enum(['none', 'env', 'oauth']),
      why: z.string(),
    }),
  ),
  plugins: z.array(z.object({ id: z.string(), packageName: z.string(), why: z.string() })),
  channels: z.array(
    z.object({
      platform: z.string(),
      why: z.string(),
      deliversCron: z.boolean(),
      /**
       * The recipe page collects this platform's bot credential itself and the
       * install binds the bot to the personality it just created. Without it
       * the "Deliver to" requirement is unsatisfiable: a bot binds to a
       * PERSONALITY, and the personality does not exist until the recipe runs.
       */
      inlineSetup: z.boolean().optional(),
    }),
  ),
  tools: z.array(z.string()),
  /**
   * Credentials the granted tools need before they do anything. `web_search`
   * reports itself available with no key configured (the key may live in Named
   * Secrets, unreachable at filter time), so nothing else in preflight can
   * catch a missing one.
   */
  secrets: z
    .array(z.object({ toolName: z.string(), label: z.string(), why: z.string() }))
    .optional(),
  hostBinaries: z
    .array(z.object({ name: z.string(), why: z.string(), installHint: z.string() }))
    .optional(),
  inputs: z.array(RecipeInputSchema),
});

export const RecipeCronJobSchema = z.object({
  name: z.string(),
  schedule: z.string(),
  prompt: z.string(),
  missedRunPolicy: MissedRunPolicySchema.optional(),
  /** Which `deliverTo` arm this job wants. `channel` needs a target at install. */
  deliverTo: z.enum(['channel', 'inApp', 'none']),
});

export const RecipePostInstallSchema = z.object({
  kind: z.enum(['oauth', 'token', 'restart', 'manual']),
  label: z.string(),
  detail: z.string(),
  href: z.string().optional(),
});

export const RecipeBundleWireSchema = z.object({
  id: z.string(),
  /** Optimistic concurrency on the preview — `install` sends it back. */
  version: z.number().int().positive(),
  title: z.string(),
  summary: z.string(),
  sourceDoc: z.string().optional(),
  tags: z.array(z.string()),
  personality: RecipePersonalitySchema,
  requires: RecipeRequirementsSchema,
  cronJobs: z.array(RecipeCronJobSchema),
  starterPrompt: z.string(),
  examplePrompts: z.array(z.string()),
  notes: z.array(z.string()),
  postInstall: z.array(RecipePostInstallSchema),
});
export type RecipeBundleWire = z.infer<typeof RecipeBundleWireSchema>;

/** One gallery row. Everything the list needs and nothing it does not. */
export const RecipeListItemSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  sourceDoc: z.string().nullable(),
  /**
   * Attach-mode recipes only: the ids of the personalities whose SOUL.md
   * carries this recipe's marker section — DERIVED on every call, never
   * stored (D8). `null` for a create-mode recipe, whose installed state the
   * gallery derives from whether its bundle's personality id exists.
   */
  attachedTo: z.array(z.string()).nullable(),
});
export type RecipeListItem = z.infer<typeof RecipeListItemSchema>;

export const RecipePreflightSchema = z.object({
  /** Unmet prerequisites. Each carries an action a user can actually perform. */
  blocking: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      action: z.string(),
      href: z.string().optional(),
    }),
  ),
  /** Required inputs still empty. Shrinks as the user fills the form in. */
  needsInput: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      kind: z.string(),
      help: z.string(),
      suggested: z.string().optional(),
      /**
       * `kind: 'credential'` only — the providers that clear this row, ANY one
       * of which is enough. The page renders the same `SecretPicker` the
       * personality tool-settings form uses: existing keys of `secretKind` are
       * offered for selection, and a new one is created through the vault's own
       * write path. The VALUE never travels on this wire in either direction,
       * exactly as the Telegram bot token is kept off `inputs` (D14).
       */
      credentialOptions: z
        .array(
          z.object({
            /**
             * What a binding names: the provider — narrowed by the caller
             * against the derived provider roster. Left as a plain string here
             * so a tool whose provider roster grows still produces a VALID
             * response (the server simply offers no option for it) rather than
             * one this contract rejects.
             */
            provider: z.string(),
            label: z.string(),
            /**
             * The name the tool resolves under this provider when nothing binds
             * it — `apiKey`. Read off the key store's own ref, so preflight can
             * tell "no binding, but the default key is there" from "unset".
             */
            defaultSecretName: z.string(),
            getKeyUrl: z.string().optional(),
          }),
        )
        .optional(),
      /** `kind: 'credential'` only — the `secretKind` the picker filters by. */
      secretKind: z.string().optional(),
    }),
  ),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  willCreate: z.object({
    personality: z.object({ id: z.string(), isNew: z.boolean() }),
    cronJobs: z.array(
      z.object({
        name: z.string(),
        schedule: z.string(),
        nextRun: z.string().nullable(),
        exists: z.boolean(),
      }),
    ),
    mcpAttachments: z.array(z.string()),
  }),
  /** The preview (D5) — `renderCharacterSheet` over the proposed config. */
  characterSheet: z.string(),
  /** What the installer cannot do, echoed so the confirm step needs no second call. */
  postInstall: z.array(RecipePostInstallSchema),
});
export type RecipePreflight = z.infer<typeof RecipePreflightSchema>;

/**
 * Stage 6. `ok: false` is an APPLY failure that was compensated — stages 1-4
 * refuse by throwing (`RECIPE_NOT_FOUND` / `RECIPE_INVALID` / `RECIPE_STALE` /
 * `RECIPE_BLOCKED`) because nothing was attempted and an all-empty report
 * would say less than the error does.
 */
export const RecipeInstallReportSchema = z.object({
  ok: z.boolean(),
  created: z.object({
    /**
     * The personality this install WROTE: the one it created (create mode) or
     * the one it attached its section to (attach mode). Null when nothing was
     * written — a re-install that skipped it, or a rolled-back failure.
     */
    personality: z.string().nullable(),
    /** `@briefer_bot` when the install set up the channel bot itself. */
    channelBot: z.string().nullable(),
    cronJobs: z.array(z.string()),
    mcpAttachments: z.array(z.string()),
  }),
  skipped: z.array(z.object({ what: z.string(), because: z.string() })),
  /** Compensating deletes this apply performed, and whether each one worked. */
  rolledBack: z.array(z.object({ what: z.string(), ok: z.boolean() })),
  /** Compensation that itself failed — named, with the page that cleans it up. */
  orphaned: z.array(z.object({ what: z.string(), href: z.string() })),
  /** Why the apply failed. Null on success. */
  failure: z.object({ code: z.string(), message: z.string(), action: z.string() }).nullable(),
  /** The honest-completion checklist (D6) — what is left for the human. */
  remaining: z.array(RecipePostInstallSchema),
  /** Pre-filled into the composer. Never auto-sent. */
  starterPrompt: z.string(),
});
export type RecipeInstallReport = z.infer<typeof RecipeInstallReportSchema>;

/**
 * One chat that has messaged a bot, as a one-shot `getUpdates` found it.
 *
 * R0's invariant is intact: a chat id is resolved by the SERVER and chosen from
 * a list. There is no free-text chat id field anywhere, here or in the UI.
 */
export const RecipeDiscoveredChatSchema = z.object({
  chatId: z.string(),
  /** The group's title, or the sender's name — never a bare id. */
  label: z.string(),
  /** `private` | `group` | `supergroup` | `channel`. */
  kind: z.string(),
});
export type RecipeDiscoveredChat = z.infer<typeof RecipeDiscoveredChatSchema>;

/**
 * `status` is the whole contract here:
 *
 * - `ok` — Telegram answered; `chats` is what has messaged this bot.
 * - `waiting` — the token is good, but nothing has messaged the bot yet. The
 *   user opens Telegram, sends a message, and presses the button again.
 * - `gateway_owns_token` — Telegram answered 409, which means the RUNNING
 *   GATEWAY is long-polling this token. Not an error: the gateway's own pairing
 *   store and lane keys already know the chat, so the page falls back to
 *   `cron.deliveryTargets` and says so.
 * - `rejected` / `unreachable` — the token was refused, or Telegram could not
 *   be reached. `error` is one line for a human and NEVER contains the token.
 */
export const RecipeDiscoverChatsOutputSchema = z.object({
  status: z.enum(['ok', 'waiting', 'gateway_owns_token', 'rejected', 'unreachable']),
  /** `@botname`, echoed back so the user can confirm they pasted the right token. */
  botLabel: z.string().nullable(),
  chats: z.array(RecipeDiscoveredChatSchema),
  error: z.string().nullable(),
});
export type RecipeDiscoverChatsOutput = z.infer<typeof RecipeDiscoverChatsOutputSchema>;

/**
 * Inline channel setup, sent with `recipes.install`.
 *
 * The token is a CREDENTIAL and is deliberately NOT a `requires.inputs` entry:
 * inputs are echoed in `needsInput`, cached in the client's preflight query key
 * and re-sent on every keystroke, and substituted into SOUL.md through
 * `{{input.*}}`. A separate field keeps the token off all four paths — it
 * travels once, on the one call that needs it.
 *
 * `chatId` is a `recipes.discoverChats` row the user picked. The install
 * re-reads Telegram to authorize it rather than trusting this value.
 */
export const RecipeChannelSetupSchema = z.object({
  platform: z.literal('telegram'),
  token: z.string().min(1),
  chatId: z.string().min(1),
});
export type RecipeChannelSetup = z.infer<typeof RecipeChannelSetupSchema>;

/**
 * Which named secret a credential requirement is answered with, keyed by the
 * `requires.secrets[].toolName` it answers. Sent with `recipes.preflight` (so
 * the row clears live) and with `recipes.install` (which writes it onto the
 * personality's tool settings as `providers/<provider>/<secret>`).
 *
 * A REFERENCE, never a credential: `secret` is a vault NAME. The value is
 * written by `namedSecrets.create` — the store that owns it — and never enters
 * a recipe input, a preflight report, an install call or an error.
 */
export const RecipeSecretBindingsSchema = z.record(
  z.string(),
  z.object({ provider: z.string().min(1), secret: z.string().min(1) }),
);
export type RecipeSecretBindings = z.infer<typeof RecipeSecretBindingsSchema>;
