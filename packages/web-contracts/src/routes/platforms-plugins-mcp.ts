import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  BotBindingSchema,
  ChannelPlatformFilterSchema,
  CredentialKeyInfoSchema,
  McpAddServerInputSchema,
  McpAddServerOutputSchema,
  McpAttachInputSchema,
  McpAttachOutputSchema,
  McpCancelInputSchema,
  McpCatalogOutputSchema,
  McpCompleteInputSchema,
  McpCompleteOutputSchema,
  McpConnectPresetInputSchema,
  McpConnectPresetOutputSchema,
  McpDeleteInputSchema,
  McpListOutputSchema,
  McpPersonalityServersInputSchema,
  McpPersonalityServersOutputSchema,
  McpReconnectInputSchema,
  McpRefreshTokenInputSchema,
  McpRefreshTokenOutputSchema,
  McpRenameInputSchema,
  McpRenameOutputSchema,
  McpScopeStatusInputSchema,
  McpScopeStatusOutputSchema,
  McpServerInfoSchema,
  McpServerToolsInputSchema,
  McpServerToolsOutputSchema,
  McpStartInputSchema,
  McpStartOutputSchema,
  McpStatusOutputSchema,
  McpUpdateTokenInputSchema,
  McpUpdateTokenOutputSchema,
  McpValidateConfigInputSchema,
  McpValidateConfigOutputSchema,
  PlatformIdSchema,
  PlatformStatusSchema,
  PluginInfoSchema,
  SlackAppEntrySchema,
  TelegramBotEntrySchema,
  WhatsAppChannelModeSchema,
  WhatsAppEntrySchema,
} from '../schemas';

// ---------------------------------------------------------------------------
// Communications (v1)
//
// Per-platform connection state + setup form. Read returns only
// configured-ness flags; secrets never cross the wire. Update accepts
// per-field plaintext; empty / omitted fields preserve the existing
// value (so users can rotate one secret without re-entering all).
// ---------------------------------------------------------------------------

const PlatformsListOutput = z.object({ platforms: z.array(PlatformStatusSchema) });

const PlatformsSetInput = z.object({
  id: PlatformIdSchema,
  /** Per-field plaintext. Field names match the schema each platform
   *  declares — e.g. telegram = { token }, slack = { botToken,
   *  appToken, signingSecret }. Empty / missing keys preserve the
   *  current value. */
  fields: z.record(z.string(), z.string()),
});
const PlatformsSetOutput = z.object({ platform: PlatformStatusSchema });

const PlatformsClearInput = z.object({ id: PlatformIdSchema });
const PlatformsClearOutput = z.object({ platform: PlatformStatusSchema });

// W2.1 — live token probe. Runs the per-platform validator server-side and
// returns a W1.2 liveness verdict so onboarding can distinguish a rejected
// token (Continue disabled) from an unreachable platform (saved unverified).
const PlatformsValidateInput = z.object({
  id: PlatformIdSchema,
  fields: z.record(z.string(), z.string()),
});
const PlatformsValidateOutput = z.object({
  /** `ok` — token accepted; `rejected` — definitively bad (401/403);
   *  `unreachable` — outage (timeout/DNS/5xx/429); `unsupported` — no probe
   *  exists for this platform (e.g. email). */
  status: z.enum(['ok', 'rejected', 'unreachable', 'unsupported']),
  /** `@botname` / workspace name on success, else null. */
  label: z.string().nullable(),
  error: z.string().nullable(),
});

/** @experimental */
export const platforms = {
  list: oc.output(PlatformsListOutput),
  set: oc.input(PlatformsSetInput).output(PlatformsSetOutput),
  clear: oc.input(PlatformsClearInput).output(PlatformsClearOutput),
  validate: oc.input(PlatformsValidateInput).output(PlatformsValidateOutput),
  botsListTelegram: oc.output(z.object({ bots: z.array(TelegramBotEntrySchema) })),
  botsAddTelegram: oc
    .input(
      z.object({
        token: z.string().min(1),
        bind: BotBindingSchema,
        username: z.string().optional(),
      }),
    )
    .output(z.object({ bot: TelegramBotEntrySchema })),
  botsRemoveTelegram: oc
    .input(z.object({ botKey: z.string() }))
    .output(z.object({ ok: z.literal(true) })),

  botsListSlack: oc.output(z.object({ bots: z.array(SlackAppEntrySchema) })),
  botsAddSlack: oc
    .input(
      z.object({
        botToken: z.string().min(1),
        appToken: z.string().min(1),
        signingSecret: z.string().min(1),
        bind: BotBindingSchema,
      }),
    )
    .output(z.object({ bot: SlackAppEntrySchema })),
  botsRemoveSlack: oc
    .input(z.object({ botKey: z.string() }))
    .output(z.object({ ok: z.literal(true) })),

  // WhatsApp: no tokens/secrets. An entry is routing knobs + a personality/team
  // `bind`; pairing happens out-of-band via QR (the setup-whatsapp SSE flow).
  botsListWhatsApp: oc.output(z.object({ bots: z.array(WhatsAppEntrySchema) })),
  botsAddWhatsApp: oc
    .input(
      z.object({
        id: z.string().optional(),
        defaultMode: WhatsAppChannelModeSchema.optional(),
        allowedNumbers: z.array(z.string()).optional(),
        phoneNumber: z.string().optional(),
        bind: BotBindingSchema,
      }),
    )
    .output(z.object({ bot: WhatsAppEntrySchema })),
  botsRemoveWhatsApp: oc
    .input(z.object({ botKey: z.string() }))
    .output(z.object({ ok: z.literal(true) })),

  getChannelFilter: oc
    .input(z.object({ platform: z.string() }))
    .output(z.object({ filter: ChannelPlatformFilterSchema })),

  setChannelFilter: oc
    .input(z.object({ platform: z.string(), filter: ChannelPlatformFilterSchema }))
    .output(z.object({ filter: ChannelPlatformFilterSchema })),
};

// ---------------------------------------------------------------------------
// Plugins + MCP (v1)
//
// Returns the union of installed plugins (discovered in user / project
// / npm dirs) and configured MCP servers. install/uninstall delegate to
// npm under the hood (same as the CLI's `ethos plugin install / remove`).
// ---------------------------------------------------------------------------

const PluginsListOutput = z.object({
  plugins: z.array(PluginInfoSchema),
  mcpServers: z.array(McpServerInfoSchema),
});

/** Mirrors `isValidPluginId` (`extensions/plugin-loader/src/lockfile.ts`), the rule
 *  `PluginsService.install` applies before running npm — web-contracts cannot import
 *  plugin-loader. `apps/web-api/src/__tests__/routes/plugins-install-rpc.test.ts` pins
 *  the two to the same verdicts. */
const PluginsInstallPersonalityId = z
  .string()
  .max(214)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
/** `personalityId` is `ethos plugin install --personality`: when present the install
 *  also writes that personality's `plugins.lock` entry; when absent it records only
 *  the capability grant. The workspace plugins page (`/p/:personalityId/plugins`)
 *  sends its route's id, so its installs write the pin; the global Library Plugins
 *  page and the create wizard send none and install globally (the wizard because
 *  the personality does not exist until it is submitted). */
const PluginsInstallInput = z.object({
  packageSpec: z.string().min(1),
  personalityId: PluginsInstallPersonalityId.optional(),
});
const PluginsInstallOutput = z.object({ ok: z.literal(true) });
const PluginsUninstallInput = z.object({ pluginId: z.string().min(1) });
const PluginsUninstallOutput = z.object({ ok: z.literal(true) });

const PluginsSetCredentialInput = z.object({
  pluginId: z.string().min(1),
  key: z.string().min(1),
  value: z.string(),
});
const PluginsSetCredentialOutput = z.object({ ok: z.literal(true) });

const PluginsGetCredentialMetaInput = z.object({
  pluginId: z.string().min(1),
  key: z.string().min(1),
});
const PluginsGetCredentialMetaOutput = z.object({
  updatedAt: z.string().nullable(),
});

const PluginsListCredentialKeysInput = z.object({
  pluginId: z.string().min(1),
});
const PluginsListCredentialKeysOutput = z.object({
  keys: z.array(CredentialKeyInfoSchema),
});

const PluginsGetPageSpecInput = z.object({ pluginId: z.string().min(1) });
const PluginsGetPageSpecOutput = z.object({
  spec: z
    .object({
      title: z.string(),
      icon: z.string().optional(),
      sections: z.array(z.record(z.string(), z.unknown())),
      showInSidebar: z.boolean().optional(),
    })
    .nullable(),
});

const PluginsInvokeToolForPageInput = z.object({
  pluginId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});
const PluginsInvokeToolForPageOutput = z.object({
  ok: z.boolean(),
  value: z.string(),
  structured: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

const PluginsGetCredentialInput = z.object({
  pluginId: z.string().min(1),
  ref: z.string().min(1),
});
const PluginsGetCredentialOutput = z.object({
  value: z.string().nullable(),
});

const PluginsCredentialPreviewInput = z.object({
  pluginId: z.string().min(1),
  ref: z.string().min(1),
});
const PluginsCredentialPreviewOutput = z.object({
  preview: z.string().nullable(),
});

const PluginsExecuteToolInput = z.object({
  pluginId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});
const PluginsExecuteToolOutput = z.object({
  ok: z.boolean(),
  value: z.string().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});

const PluginsRequestOAuthInput = z.object({
  pluginId: z.string(),
  oauthRef: z.string(),
});
const PluginsRequestOAuthOutput = z.object({
  url: z.string(),
});

const PluginsCompleteOAuthInput = z.object({
  pluginId: z.string(),
  oauthRef: z.string(),
  requestToken: z.string(),
});
const PluginsCompleteOAuthOutput = z.object({
  ok: z.boolean(),
  userId: z.string().optional(),
});

/** @experimental */
export const plugins = {
  list: oc.output(PluginsListOutput),
  install: oc.input(PluginsInstallInput).output(PluginsInstallOutput),
  uninstall: oc.input(PluginsUninstallInput).output(PluginsUninstallOutput),
  setCredential: oc.input(PluginsSetCredentialInput).output(PluginsSetCredentialOutput),
  getCredentialMeta: oc.input(PluginsGetCredentialMetaInput).output(PluginsGetCredentialMetaOutput),
  listCredentialKeys: oc
    .input(PluginsListCredentialKeysInput)
    .output(PluginsListCredentialKeysOutput),
  getPageSpec: oc.input(PluginsGetPageSpecInput).output(PluginsGetPageSpecOutput),
  invokeToolForPage: oc.input(PluginsInvokeToolForPageInput).output(PluginsInvokeToolForPageOutput),
  getCredential: oc.input(PluginsGetCredentialInput).output(PluginsGetCredentialOutput),
  credentialPreview: oc.input(PluginsCredentialPreviewInput).output(PluginsCredentialPreviewOutput),
  executeTool: oc.input(PluginsExecuteToolInput).output(PluginsExecuteToolOutput),
  requestOAuth: oc.input(PluginsRequestOAuthInput).output(PluginsRequestOAuthOutput),
  completeOAuth: oc.input(PluginsCompleteOAuthInput).output(PluginsCompleteOAuthOutput),
};

// ---------------------------------------------------------------------------
// MCP install flow (v1 — OAuth UI)
//
// Server-side orchestration for the MCP OAuth dance: discover, register
// a dynamic client, redirect the user to the upstream authorization
// endpoint, then exchange the code for tokens and persist the server.
// ---------------------------------------------------------------------------

/** @experimental */
export const mcp = {
  start: oc.input(McpStartInputSchema).output(McpStartOutputSchema),
  complete: oc.input(McpCompleteInputSchema).output(McpCompleteOutputSchema),
  status: oc.output(McpStatusOutputSchema),
  cancel: oc.input(McpCancelInputSchema).output(z.object({ ok: z.literal(true) })),
  attachPersonalities: oc.input(McpAttachInputSchema).output(McpAttachOutputSchema),
  list: oc.output(McpListOutputSchema),
  delete: oc.input(McpDeleteInputSchema).output(z.object({ ok: z.literal(true) })),
  reconnect: oc.input(McpReconnectInputSchema).output(McpStartOutputSchema),
  /** List the bare tool names a given MCP server exposes, for the
   *  per-server tool checklist in the personality editor. */
  serverTools: oc.input(McpServerToolsInputSchema).output(McpServerToolsOutputSchema),
  /** List MCP servers attached to a personality with their OAuth auth status. */
  personalityServers: oc
    .input(McpPersonalityServersInputSchema)
    .output(McpPersonalityServersOutputSchema),
  addServer: oc.input(McpAddServerInputSchema).output(McpAddServerOutputSchema),
  /** Onboarding connector step: add a no-sign-in remote preset to the running
   *  manager and attach it to ONE personality (plan keyless-first-run §5.2). */
  connectPreset: oc.input(McpConnectPresetInputSchema).output(McpConnectPresetOutputSchema),
  refreshToken: oc.input(McpRefreshTokenInputSchema).output(McpRefreshTokenOutputSchema),
  rename: oc.input(McpRenameInputSchema).output(McpRenameOutputSchema),
  updateToken: oc.input(McpUpdateTokenInputSchema).output(McpUpdateTokenOutputSchema),
  scopeStatus: oc.input(McpScopeStatusInputSchema).output(McpScopeStatusOutputSchema),
  validateConfig: oc.input(McpValidateConfigInputSchema).output(McpValidateConfigOutputSchema),
  /** The curated preset catalog, so the browser never imports the Node-only tools-mcp package. */
  catalog: oc.output(McpCatalogOutputSchema),
};
