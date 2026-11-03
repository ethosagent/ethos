import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  CronDeliverToSchema,
  RecipeBundleWireSchema,
  RecipeChannelSetupSchema,
  RecipeDiscoverChatsOutputSchema,
  RecipeInstallModeSchema,
  RecipeInstallReportSchema,
  RecipeListItemSchema,
  RecipePreflightSchema,
  RecipeSecretBindingsSchema,
} from '../schemas';

// ---------------------------------------------------------------------------
// Documents — the operator's view of the files the agent writes
//
// Rooted at the personality's declared `fs_reach.workdir`, NOT its personality
// directory: SOUL.md / config.yaml / mcp.yaml stay off this surface. Every
// `path` is RELATIVE to that root; the service joins and lets `ScopedStorage`
// judge, so a `..` or absolute path is refused rather than interpreted.
//
// Bytes never travel over RPC. Download is a streaming, cookie-authenticated
// `GET /documents/download` — see `apps/web-api/src/routes/documents.ts`.
// ---------------------------------------------------------------------------

const DocumentEntrySchema = z.object({
  name: z.string(),
  /** Path relative to the workdir root — feed it straight back to list/delete. */
  path: z.string(),
  isDir: z.boolean(),
  /** Absent for directories and for entries that could not be stat'd. */
  size: z.number().optional(),
  mtimeMs: z.number().optional(),
  /** Symlinks are LISTED so the operator can see them, but refused on
   *  download and delete — they can point outside the workdir. */
  isSymlink: z.boolean(),
});

/**
 * Which scope the call addresses: a personality (omitted `personalityId` means
 * the configured default) or, with `team`, a team's work directory
 * (`~/.ethos/teams/<team>/`, its one root). Passing both is refused.
 */
const DocumentsScopeInput = z.object({
  personalityId: z.string().min(1).optional(),
  team: z.string().min(1).optional(),
});

/**
 * Every root the scope declares. `id` is opaque to the client — feed it back
 * as `root` on list/delete/createFolder and on the download/upload routes.
 * Exactly one of `personalityId` / `team` echoes which scope answered.
 *
 * An EMPTY `roots` array is the "Documents unconfigured" answer, not an error:
 * the personality declares no `fs_reach.workdir` at all (or the team has no
 * work directory yet), so there is nothing to browse. Every other procedure
 * fails with `WORKDIR_NOT_CONFIGURED` in that state; `root` is the discovery
 * call that lets the UI say so plainly.
 */
const DocumentsRootOutput = z.object({
  roots: z.array(z.object({ id: z.string(), path: z.string() })),
  personalityId: z.string().optional(),
  team: z.string().optional(),
});

/** Which declared root the operation addresses — an `id` from `documents.root`. */
const DocumentsRootInput = DocumentsScopeInput.extend({ root: z.string().min(1) });

const DocumentsListInput = DocumentsRootInput.extend({
  /** Subdirectory relative to the root. Omitted = the root itself. */
  path: z.string().optional(),
});
const DocumentsListOutput = z.object({ entries: z.array(DocumentEntrySchema) });

const DocumentsDeleteInput = DocumentsRootInput.extend({ path: z.string().min(1) });
const DocumentsDeleteOutput = z.object({ ok: z.literal(true) });

/** Creates exactly ONE directory — the parent must already exist. */
const DocumentsCreateFolderInput = DocumentsRootInput.extend({ path: z.string().min(1) });

/** @experimental */
export const documents = {
  root: oc.input(DocumentsScopeInput).output(DocumentsRootOutput),
  list: oc.input(DocumentsListInput).output(DocumentsListOutput),
  delete: oc.input(DocumentsDeleteInput).output(DocumentsDeleteOutput),
  // No `upload` here on purpose — bytes never travel over RPC (see the
  // namespace note above). Upload is `POST /documents/upload`, a raw
  // cookie-authed Hono route, exactly as download is a raw GET.
  createFolder: oc.input(DocumentsCreateFolderInput).output(DocumentEntrySchema),
};

// ---------------------------------------------------------------------------
// Recipes — one-click use-case bundles (plan/phases/recipes-gallery.md §4)
//
// `list` takes no input: the catalog is curated, static and small, the same
// call shape as `mcp.catalog` and `dashboards.listWidgetTemplates`. Filtering
// by tag is client-side; a query parameter on a three-row list is speculative.
//
// There is deliberately NO `installStream`. Install is three bounded writes;
// SSE would buy latency theatre and cost a second protocol.
// ---------------------------------------------------------------------------

const RecipesListOutput = z.object({ recipes: z.array(RecipeListItemSchema) });

const RecipesGetInput = z.object({ id: z.string().min(1) });
const RecipesGetOutput = z.object({ recipe: RecipeBundleWireSchema });

/**
 * Read-only, repeatable, and stateless — there is no server-side wizard
 * session, so a reload loses nothing and nothing can expire. `inputs` is
 * whatever the user has typed SO FAR: the `needsInput` list shrinks live as it
 * fills. `characterSheet` rides along so the preview needs no second call.
 */
const RecipesPreflightInput = z.object({
  id: z.string().min(1),
  inputs: z.record(z.string(), z.string()).optional(),
  /**
   * Create mode: install under a different personality id (the collision
   * escape hatch). Attach mode: the TARGET personality the recipe attaches
   * to — required there, and preflight emits `PERSONALITY_REQUIRED` until it
   * is given.
   */
  personalityIdOverride: z.string().min(1).optional(),
  /**
   * For a `mode: 'both'` recipe: which view to preflight — `create` (default)
   * or `attach`. Ignored for a single-mode recipe, whose mode is its own.
   */
  installMode: RecipeInstallModeSchema.optional(),
  /**
   * The named secret picked for each credential requirement. Preflight's
   * satisfied-check runs against THIS binding — the one the install would
   * write — so the row clears only when the chosen key actually exists.
   */
  secretBindings: RecipeSecretBindingsSchema.optional(),
});

/**
 * `version` is optimistic concurrency on the preview: a client that previewed
 * v1 and installs against a shipped v2 is refused with `RECIPE_STALE` and
 * re-previews. Without it, an upgrade during a long confirm step silently
 * installs something the user never saw.
 *
 * `deliverTo` is the authoritative delivery target for every cron job the
 * bundle marks `deliverTo: 'channel'`. It is a `cron.deliveryTargets` row the
 * user picked — never free text, and re-validated server-side by
 * `CronService.create` whatever the client previewed.
 */
const RecipesInstallInput = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  inputs: z.record(z.string(), z.string()),
  /** Same meaning as on `preflight`: an alternate id (create) or the target (attach). */
  personalityIdOverride: z.string().min(1).optional(),
  /** Same meaning as on `preflight`: the view a `both` recipe installs as. */
  installMode: RecipeInstallModeSchema.optional(),
  deliverTo: CronDeliverToSchema.optional(),
  /**
   * Inline channel setup — the fix for the chicken-and-egg that made
   * "Deliver to" permanently unsatisfiable. `platforms.botsAddTelegram`
   * requires a `bind` naming an EXISTING personality, and the recipe's
   * personality does not exist until the install creates it, so the bot cannot
   * be made in Communications beforehand. The install therefore makes it, in
   * order: create the personality, add and bind the bot, then the cron job.
   *
   * Mutually exclusive with `deliverTo`: this arm's `botKey` is not knowable
   * until the bot exists, so the server derives the delivery target itself.
   */
  channelSetup: RecipeChannelSetupSchema.optional(),
  /**
   * The named secret each credential requirement was answered with. The install
   * writes it onto the new personality's tool settings, because a key stored
   * under any name but the tool's default is invisible to the tool without a
   * binding — a silent no-results agent, which is what this whole step exists
   * to prevent. A binding naming a secret that does not exist leaves the
   * requirement unsatisfied, so the install refuses before the first write.
   */
  secretBindings: RecipeSecretBindingsSchema.optional(),
});

/**
 * READ-ONLY. One `getUpdates` per press — never a long poll, and never with an
 * `offset`, which would acknowledge the user's message and delete the very
 * update the install re-reads to authorize their pick.
 */
const RecipesDiscoverChatsInput = z.object({
  platform: z.literal('telegram'),
  token: z.string().min(1),
});

/** @experimental */
export const recipes = {
  list: oc.output(RecipesListOutput),
  get: oc.input(RecipesGetInput).output(RecipesGetOutput),
  preflight: oc.input(RecipesPreflightInput).output(RecipePreflightSchema),
  discoverChats: oc.input(RecipesDiscoverChatsInput).output(RecipeDiscoverChatsOutputSchema),
  install: oc.input(RecipesInstallInput).output(RecipeInstallReportSchema),
};
