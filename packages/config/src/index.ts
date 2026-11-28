import { join } from 'node:path';
import { deriveBotKey as deriveBotKeyFromSeed } from '@ethosagent/core';
import type { SecretsResolver, Storage } from '@ethosagent/types';
import { rejectUnsafeIdent } from './bots';
import type { BotBinding, SlackAppConfig, TelegramBotConfig } from './builders/platforms';
import type { WebhookHookConfig } from './builders/webhooks';
import type { EthosConfig } from './config-types';
import { unexpressibleLines, weaveComments } from './io';
import type { KeyProfile } from './keys';
import { ethosDir } from './paths';
import { assertWritableConfigLines } from './scalar';
import {
  externalizeProviderChain,
  externalizeSecret,
  type SecretRefContext,
  secretRefForConfigKey,
  validateNoPlaintextSecrets,
} from './secrets';
import { serializeConfigLines } from './serialize';

export { applyPlatformShim, bindResolvesToPersonality } from './bots';
export { normalizeAuxTimeoutSeconds } from './builders/agent';
export {
  type ChannelsLine,
  type ChannelsPlatformConfig,
  parseChannelsLine,
  type RawRoomEntry,
} from './builders/channels';
export {
  type BackgroundConfig,
  backgroundDefaults,
  type CronTopLevelConfig,
} from './builders/cron-background';
export { dockerImageRefError } from './builders/execution';
export {
  LEARNING_REPLAY_DEFAULTS,
  type LearningReplaySettings,
  resolveLearningReplay,
} from './builders/learning';
export type {
  MemoryApprovalConfig,
  MemoryCaptureConfig,
  MemoryConsolidationConfig,
  MemoryVaultConfig,
} from './builders/memory';
export type {
  BotBinding,
  BotBudgetConfig,
  SlackAppConfig,
  TeamRuntimeConfig,
  TelegramBotConfig,
  WhatsAppConfig,
} from './builders/platforms';
export { type ResolvedShareLinks, resolveShareLinks } from './builders/share-links';
export {
  PLUGIN_ISOLATION_DEFAULTS,
  type PluginIsolationConfig,
  type PluginIsolationMode,
  TOOL_LOADING_MODES,
  type ToolLoadingMode,
} from './builders/tools';
export {
  WEBHOOK_HMAC_ALGORITHMS,
  type WebhookDeliveryTargetConfig,
  type WebhookHmacConfig,
  type WebhookHookConfig,
  type WebhookRateLimitConfig,
} from './builders/webhooks';
export { type ResolvedWorldSettings, resolveWorld } from './builders/world';
export type { EthosConfig } from './config-types';
// Plan decision-provider-jev §7 — the operator's `decisions.*` keys and their
// resolver (defaults, per-site budgets); plan decision-provider-personality
// §4.4 — the one per-personality site resolver (R6's `on` → `shadow` included).
export {
  DECISION_PROVIDERS,
  DECISION_SITE_DEFAULT_TIMEOUT_MS,
  DECISION_SITE_MODES,
  DECISION_SITES,
  DECISIONS_API_KEY_REF,
  DECISIONS_DEFAULT_BASE_URL,
  DECISIONS_DEFAULT_MODEL,
  DECISIONS_DEFAULT_TIMEOUT_MS,
  type DecisionProviderName,
  type DecisionSiteId,
  type DecisionSiteMode,
  type DecisionsConfig,
  decisionToolEnabled,
  describeDecisionSiteDowngrade,
  missingThresholdKeys,
  type PersonalityDecisionSiteReason,
  type PersonalityDecisionsInput,
  type ResolvedDecisionSite,
  type ResolvedDecisionsConfig,
  resolveDecisionSiteMode,
  resolveDecisionsConfig,
  resolvePersonalityDecisionSite,
} from './decisions';
export { type EffectiveConfig, resolveEffectiveConfig } from './effective';
export { type LoadedConfig, loadConfigStrict, readConfig, readRawConfig } from './io';
export {
  type ActiveContext,
  type EngineAskToolSetting,
  type KeyProfile,
  normalizeWebSearchRecency,
  type PersonalityToolSettings,
  readKeys,
  rotationSecretRef,
  type SearchConsoleToolSetting,
  type ToolSettingsMap,
  type WebSearchToolSetting,
  type XSearchToolSetting,
  type YouTubeToolSetting,
} from './keys';
export { EXTERNALLY_READ_CONFIG_KEYS, KNOWN_CONFIG_KEYS, KNOWN_KEY_PREFIXES } from './known-keys';
// D11(a) — the ONE chain-model importer (`ethos migrate models`,
// `modelRegistry.importChain` / `list.chainModels`, `config.update` adopt-on-save).
export {
  type AdoptedModel,
  type CatalogModelFacts,
  type CatalogModelLookup,
  type ChainModelCandidate,
  type ChainModelImportOptions,
  type ChainModelImportPlan,
  type ChainModelImportSource,
  planChainModelImport,
  slugifyModelAlias,
  uniqueModelAlias,
} from './model-import';
// D25/T1.3 — the registry's refusals and the config-shaped declaration parser.
// They live in their own module because this one is the CODEC and deliberately
// refuses nothing (see `buildModelRegistry`); re-exported here because
// `packages/config` has one public surface.
export {
  introducedModelRegistryProblems,
  type ModelRegistryProblem,
  type ModelRegistryProblemCode,
  parseModelDeclaration,
  validateModelRegistry,
} from './model-registry';
export {
  isModelRegistryLine,
  parseModelRegistry,
  renderModelRegistry,
  renderModelRegistryPairs,
} from './model-registry-config';
// Plan ux-feedback-and-config-clarity B2 — the shared typo-suggestion helper,
// re-exported for the CLI's unknown-command hint (N1) and `ethos doctor`.
export { damerauLevenshtein, nearestKey } from './nearest-key';
export { adoptConfigNotices, configParseNotices, observeModePlatforms } from './notices';
export {
  hostTimeZone,
  isValidTimeZone,
  type NotificationsConfig,
  parseQuietHoursSpec,
} from './notifications';
export { parseConfigYaml } from './parse';
export { ethosCronDir, ethosDir, ethosScriptsDir } from './paths';
export {
  deriveProviderKey,
  fillFromTopLevel,
  isProviderChainLine,
  type ProviderChainEntry,
  type ProviderConfig,
  parseProviderChain,
  providerChainVersion,
  renderProviderChain,
} from './provider-chain';
export {
  assertWritableConfigLines,
  parseConfigScalar,
  quoteConfigScalar,
  renderConfigScalar,
} from './scalar';
export {
  externalizeProviderChain,
  externalizeSecret,
  isProviderChainSecretRef,
  resolveSecretRef,
  type SecretRefContext,
  secretRefForConfigKey,
  secretRefFromValue,
  validateNoPlaintextSecrets,
} from './secrets';
export { resolveConfigSecrets } from './secrets-config';
export {
  type AuxiliaryCompressionConfig,
  type AuxiliaryVisionConfig,
  type AuxiliaryWebConfig,
  type AwsConfig,
  type AwsSecretsConfig,
  CURRENT_ETHOS_CONFIG_SCHEMA_VERSION,
  DEFAULT_PERSONALITY_ID,
  type ModelCatalogConfig,
  type QuickCommandConfig,
  type TelemetryConfig,
  type TelemetryExportConfig,
  type TelemetryLangfuseExportConfig,
  type TelemetryOtlpExportConfig,
  type WebConfig,
} from './section-types';
export {
  isVoiceChannelPlatform,
  VOICE_CHANNEL_PLATFORMS,
  type VoiceBargeInConfig,
  type VoiceBargeInSurface,
  type VoiceBargeInTuning,
  type VoiceBotConfig,
  type VoiceFillerConfig,
  type VoiceInboundConfig,
  type VoiceLiveKitConfig,
  type VoiceTrunkConfig,
  type WakeRouteConfig,
} from './voice';

/**
 * Stable identity for a rotation key, used to name its vault ref.
 *
 * `KeyProfile` has no id field and `label` is optional and not unique, so
 * there is nothing to key on but the material itself — the same position
 * `telegram.bots.<n>` is in when the operator omits `id:`. Hashing the value
 * gives a ref that survives reordering, is identical across rewrites, and
 * leaks nothing. Reuses core's `deriveBotKey` rather than hashing here: two
 * implementations of the algorithm is two ways for it to diverge.
 *
 * Only meaningful for a plaintext value. A profile that already carries a
 * `${secrets:…}` reference keeps whatever ref it was minted with — the ref
 * derived here is discarded by `externalizeSecret`'s idempotent branch.
 */
function rotationKeyId(profile: KeyProfile): string {
  return deriveBotKeyFromSeed(profile.apiKey);
}

/**
 * Write-path mirror of `readKeys`: `apiKey` — the one credential-bearing
 * field on `KeyProfile` — is moved into the vault and replaced by its
 * `${secrets:<ref>}` reference. `priority` and `label` carry no credential
 * and are serialized as-is.
 *
 * Existing installs migrate implicitly: the first `writeKeys` after upgrade
 * lifts whatever plaintext keys.json still carries into `~/.ethos/secrets/`.
 */
async function externalizeRotationKeys(
  keys: KeyProfile[],
  secrets: SecretsResolver,
): Promise<KeyProfile[]> {
  const ctx: SecretRefContext = { rotationKeyIds: keys.map(rotationKeyId) };
  const out: KeyProfile[] = [];
  for (const [i, profile] of keys.entries()) {
    const key = `keys.${i}.apiKey`;
    const ref = secretRefForConfigKey(key, ctx);
    if (ref === null) throw new Error(`No secret ref is defined for config key '${key}'`);
    out.push({ ...profile, apiKey: await externalizeSecret(profile.apiKey, ref, secrets) });
  }
  return out;
}

/**
 * Serialize `~/.ethos/keys.json` (the key-rotation pool).
 *
 * `secrets` is REQUIRED for the same reason it is on `writeConfig`: an
 * omittable control is not a guarantee. Every key value is externalized into
 * the vault before serialization, so the file holds ordering and refs only
 * (G-SEC / ARCHITECTURE.md §V S9).
 */
export async function writeKeys(
  storage: Storage,
  keys: KeyProfile[],
  secrets: SecretsResolver,
): Promise<void> {
  const externalized = await externalizeRotationKeys(keys, secrets);
  // Fail-closed gate: the same field policy `writeConfig` applies, on exactly
  // what is about to be serialized. Reused rather than re-implemented so the
  // two write paths can never disagree about what counts as plaintext.
  validateNoPlaintextSecrets({ keys: externalized });
  await storage.mkdir(ethosDir());
  // 0o600 — keys file contains rotation key refs and ordering; restrict to owner.
  await storage.write(join(ethosDir(), 'keys.json'), `${JSON.stringify(externalized, null, 2)}\n`, {
    mode: 0o600,
  });
}

/**
 * Write-path mirror of `resolveConfigSecrets`: every credential-bearing field
 * is moved into the vault and replaced by its `${secrets:<ref>}` reference.
 * Values that are already references pass through untouched, so rewriting an
 * externalized config is a no-op on the vault.
 *
 * Existing installs migrate implicitly — the first `writeConfig` after upgrade
 * lifts whatever plaintext the file still carries into `~/.ethos/secrets/`.
 */
async function externalizeConfigSecrets(
  config: EthosConfig,
  secrets: SecretsResolver,
): Promise<EthosConfig> {
  const ctx: SecretRefContext = {
    provider: config.provider,
    telegramBotKeys: config.telegram?.bots.map((b) => deriveBotKey(b)),
    slackAppKeys: config.slack?.apps.map((a) => deriveBotKey(a)),
  };
  const ref = (key: string): string => {
    const r = secretRefForConfigKey(key, ctx);
    if (r === null) throw new Error(`No secret ref is defined for config key '${key}'`);
    return r;
  };

  const r = { ...config };
  r.apiKey = await externalizeSecret(r.apiKey, ref('apiKey'), secrets);
  r.telegramToken = await externalizeSecret(r.telegramToken, ref('telegramToken'), secrets);
  r.discordToken = await externalizeSecret(r.discordToken, ref('discordToken'), secrets);
  r.slackBotToken = await externalizeSecret(r.slackBotToken, ref('slackBotToken'), secrets);
  r.slackAppToken = await externalizeSecret(r.slackAppToken, ref('slackAppToken'), secrets);
  r.slackSigningSecret = await externalizeSecret(
    r.slackSigningSecret,
    ref('slackSigningSecret'),
    secrets,
  );
  r.emailPassword = await externalizeSecret(r.emailPassword, ref('emailPassword'), secrets);

  // The top-level key can name an index-named chain secret (a provider move);
  // count it as taken so no new chain key is minted over it.
  if (r.providers) r.providers = await externalizeProviderChain(r.providers, secrets, [r.apiKey]);
  if (r.telegram?.bots) {
    const bots: TelegramBotConfig[] = [];
    for (const [i, bot] of r.telegram.bots.entries()) {
      bots.push({
        ...bot,
        token: await externalizeSecret(bot.token, ref(`telegram.bots.${i}.token`), secrets),
        webhookSecretToken: await externalizeSecret(
          bot.webhookSecretToken,
          ref(`telegram.bots.${i}.webhookSecretToken`),
          secrets,
        ),
      });
    }
    r.telegram = { ...r.telegram, bots };
  }
  if (r.slack?.apps) {
    const apps: SlackAppConfig[] = [];
    for (const [i, app] of r.slack.apps.entries()) {
      apps.push({
        ...app,
        botToken: await externalizeSecret(app.botToken, ref(`slack.apps.${i}.botToken`), secrets),
        appToken: await externalizeSecret(app.appToken, ref(`slack.apps.${i}.appToken`), secrets),
        signingSecret: await externalizeSecret(
          app.signingSecret,
          ref(`slack.apps.${i}.signingSecret`),
          secrets,
        ),
      });
    }
    r.slack = { ...r.slack, apps };
  }
  if (r.voice?.livekit) {
    const lk = r.voice.livekit;
    r.voice = {
      ...r.voice,
      livekit: {
        ...lk,
        apiKey: await externalizeSecret(lk.apiKey, ref('voice.livekit.apiKey'), secrets),
        apiSecret: await externalizeSecret(lk.apiSecret, ref('voice.livekit.apiSecret'), secrets),
      },
    };
  }
  if (r.voice?.trunk) {
    // Both trunk credentials take the same path: `password` authenticates us to
    // the trunk outbound, `webhookSecret` authenticates the trunk to us inbound.
    // Spread conditionally so a block carrying only one does not gain an
    // `undefined` key the serializer would then have to think about.
    const trunk = r.voice.trunk;
    r.voice = {
      ...r.voice,
      trunk: {
        ...trunk,
        ...(trunk.password
          ? {
              password: await externalizeSecret(
                trunk.password,
                ref('voice.trunk.password'),
                secrets,
              ),
            }
          : {}),
        ...(trunk.webhookSecret
          ? {
              webhookSecret: await externalizeSecret(
                trunk.webhookSecret,
                ref('voice.trunk.webhookSecret'),
                secrets,
              ),
            }
          : {}),
      },
    };
  }
  // Per-ENTRY refs. A roster key must not be able to route its credential
  // around the vault, so each entry externalizes exactly like
  // `auxiliary.tts.apiKey` does — `voice.tts.providers.<name>.apiKey` →
  // `voice/tts/providers/<name>/apiKey`, and the STT and realtime rosters the
  // same way. Same-named entries in different rosters therefore land on
  // different refs and cannot overwrite each other.
  const externalizeRoster = async <E extends { apiKey?: string }>(
    kind: 'tts' | 'stt' | 'realtime',
    roster: Record<string, E>,
  ): Promise<Record<string, E>> => {
    const out: Record<string, E> = {};
    for (const [name, entry] of Object.entries(roster)) {
      out[name] = entry.apiKey
        ? {
            ...entry,
            apiKey: await externalizeSecret(
              entry.apiKey,
              ref(`voice.${kind}.providers.${name}.apiKey`),
              secrets,
            ),
          }
        : entry;
    }
    return out;
  };
  if (r.voice?.tts?.providers) {
    r.voice = {
      ...r.voice,
      tts: { providers: await externalizeRoster('tts', r.voice.tts.providers) },
    };
  }
  if (r.voice?.stt?.providers) {
    r.voice = {
      ...r.voice,
      stt: { providers: await externalizeRoster('stt', r.voice.stt.providers) },
    };
  }
  if (r.voice?.realtime?.providers) {
    r.voice = {
      ...r.voice,
      realtime: {
        ...r.voice.realtime,
        providers: await externalizeRoster('realtime', r.voice.realtime.providers),
      },
    };
  }
  if (r.auxiliary) {
    const aux = { ...r.auxiliary };
    if (aux.compression?.apiKey) {
      aux.compression = {
        ...aux.compression,
        apiKey: await externalizeSecret(
          aux.compression.apiKey,
          ref('auxiliary.compression.apiKey'),
          secrets,
        ),
      };
    }
    if (aux.vision?.apiKey) {
      aux.vision = {
        ...aux.vision,
        apiKey: await externalizeSecret(aux.vision.apiKey, ref('auxiliary.vision.apiKey'), secrets),
      };
    }
    if (aux.web?.apiKey) {
      aux.web = {
        ...aux.web,
        apiKey: await externalizeSecret(aux.web.apiKey, ref('auxiliary.web.apiKey'), secrets),
      };
    }
    if (aux.asr?.apiKey) {
      aux.asr = {
        ...aux.asr,
        apiKey: await externalizeSecret(aux.asr.apiKey, ref('auxiliary.asr.apiKey'), secrets),
      };
    }
    if (aux.tts?.apiKey) {
      aux.tts = {
        ...aux.tts,
        apiKey: await externalizeSecret(aux.tts.apiKey, ref('auxiliary.tts.apiKey'), secrets),
      };
    }
    r.auxiliary = aux;
  }
  if (r.webhooks) {
    const hooks: Record<string, WebhookHookConfig> = {};
    for (const [id, hook] of Object.entries(r.webhooks)) {
      hooks[id] = {
        ...hook,
        secret: await externalizeSecret(hook.secret, ref(`webhooks.${id}.secret`), secrets),
        // The signing secrets are credentials too — a `previousSecret` left in
        // plaintext during a rotation window is exactly as usable as the
        // current one.
        ...(hook.hmac
          ? {
              hmac: {
                ...hook.hmac,
                secret: await externalizeSecret(
                  hook.hmac.secret,
                  ref(`webhooks.${id}.hmac.secret`),
                  secrets,
                ),
                ...(hook.hmac.previousSecret
                  ? {
                      previousSecret: await externalizeSecret(
                        hook.hmac.previousSecret,
                        ref(`webhooks.${id}.hmac.previousSecret`),
                        secrets,
                      ),
                    }
                  : {}),
              },
            }
          : {}),
      };
    }
    r.webhooks = hooks;
  }
  if (r.memoryCapture?.apiKey) {
    r.memoryCapture = {
      ...r.memoryCapture,
      apiKey: await externalizeSecret(r.memoryCapture.apiKey, ref('memoryCapture.apiKey'), secrets),
    };
  }
  if (r.telemetry?.export?.langfuse?.secretKey) {
    const lf = r.telemetry.export.langfuse;
    r.telemetry = {
      ...r.telemetry,
      export: {
        ...r.telemetry.export,
        langfuse: {
          ...lf,
          secretKey: await externalizeSecret(
            lf.secretKey,
            ref('telemetry.export.langfuse.secretKey'),
            secrets,
          ),
        },
      },
    };
  }
  if (r.telemetry?.export?.otlp?.headers) {
    const otlp = r.telemetry.export.otlp;
    const headers: Record<string, string> = {};
    // Every header value is a credential (otlp-export D7) — there is no safe
    // plaintext subset, so each one is vaulted under its header name.
    for (const [name, value] of Object.entries(otlp.headers ?? {})) {
      headers[name] = await externalizeSecret(
        value,
        ref(`telemetry.export.otlp.headers.${name}`),
        secrets,
      );
    }
    r.telemetry = {
      ...r.telemetry,
      export: { ...r.telemetry.export, otlp: { ...otlp, headers } },
    };
  }
  if (r.pauseLifecycle?.http?.token) {
    const http = r.pauseLifecycle.http;
    r.pauseLifecycle = {
      ...r.pauseLifecycle,
      http: {
        ...http,
        token: await externalizeSecret(http.token, ref('pauseLifecycle.http.token'), secrets),
      },
    };
  }
  if (r.browser?.proxy?.password) {
    const proxy = r.browser.proxy;
    r.browser = {
      ...r.browser,
      proxy: {
        ...proxy,
        password: await externalizeSecret(proxy.password, ref('browser.proxy.password'), secrets),
      },
    };
  }
  return r;
}

/**
 * Serialize `~/.ethos/config.yaml`.
 *
 * `secrets` is REQUIRED, not optional: every credential value is externalized
 * into the vault before serialization, and an optional resolver would be a
 * control a caller could silently omit — which is exactly how plaintext
 * credentials kept reaching disk (G-SEC).
 */
export async function writeConfig(
  storage: Storage,
  input: EthosConfig,
  secrets: SecretsResolver,
): Promise<void> {
  const config = await externalizeConfigSecrets(input, secrets);
  // Fail-closed gate: the same field policy `loadConfigStrict` enforces at
  // boot, applied to exactly what is about to be serialized. Reused rather
  // than re-implemented so the write and boot checks can never disagree.
  validateNoPlaintextSecrets(config);
  const lines = serializeConfigLines(config);
  assertWritableConfigLines(lines);
  await storage.mkdir(ethosDir());
  const path = join(ethosDir(), 'config.yaml');
  const existing = await storage.read(path);
  if (existing !== null) lines.push(...unexpressibleLines(existing, lines));
  const out = existing !== null ? weaveComments(existing, lines) : lines;
  await storage.write(path, `${out.join('\n')}\n`, { mode: 0o600 });
}

/**
 * Derive a stable `botKey` for a bot config. Explicit `id` wins; otherwise
 * delegates to `deriveBotKey` from `@ethosagent/core` with the token as
 * seed. Stable across boots; safe to log.
 *
 * Operators who want a readable identifier should set an explicit `id:`
 * in the config.
 */
export function deriveBotKey(
  bot: { id?: string } & ({ token: string } | { botToken: string }),
): string {
  if (bot.id) return bot.id;
  const seed = 'token' in bot ? bot.token : bot.botToken;
  return deriveBotKeyFromSeed(seed);
}

/**
 * Validate that every bot binding points at a personality or team that
 * actually exists. Returns the list of human-readable error messages;
 * an empty list means the config is consistent. Boot code prints these
 * and exits non-zero rather than starting bots that will silently route
 * to nowhere.
 */
export function validateBotBindings(
  config: EthosConfig,
  deps: { personalityIds: ReadonlySet<string>; teamNames: ReadonlySet<string> },
): string[] {
  const errors: string[] = [];

  // Single namespace across telegram + slack: even though lane keys are
  // platform-scoped, an explicit `id: 'prod'` shared across platforms is a
  // foot-gun for future maintainers writing per-bot lookups. Reject up
  // front instead of waiting for someone to log just the `botKey` and
  // wonder why two bots collide.
  const seenIds = new Set<string>();

  const checkBind = (
    label: string,
    botId: string | undefined,
    bind: BotBinding,
    botKey: string,
  ): void => {
    if (botId !== undefined) rejectUnsafeIdent(`${label}.id`, botId, errors);
    rejectUnsafeIdent(`${label}.bind.name`, bind.name, errors);
    if (seenIds.has(botKey)) {
      errors.push(`${label}: duplicate botKey '${botKey}'. Set an explicit 'id:' to disambiguate.`);
    }
    seenIds.add(botKey);
    if (bind.type === 'personality' && !deps.personalityIds.has(bind.name)) {
      errors.push(
        `${label}: bind.name='${bind.name}' is not a known personality. ` +
          'Add the personality under ~/.ethos/personalities/, or fix the binding.',
      );
    }
    if (bind.type === 'team' && !deps.teamNames.has(bind.name)) {
      errors.push(
        `${label}: bind.name='${bind.name}' is not a known team. ` +
          `Add a team manifest at ~/.ethos/teams/${bind.name}.yaml, or fix the binding.`,
      );
    }
  };

  for (const [i, bot] of (config.telegram?.bots ?? []).entries()) {
    checkBind(`telegram.bots[${i}]`, bot.id, bot.bind, deriveBotKey(bot));
  }
  for (const [i, app] of (config.slack?.apps ?? []).entries()) {
    checkBind(`slack.apps[${i}]`, app.id, app.bind, deriveBotKey(app));
  }
  for (const [i, wa] of (config.whatsapp ?? []).entries()) {
    // WhatsApp bind is optional — skip entries without one. WhatsApp has no
    // token, so derive the botKey from the explicit id (positional fallback).
    if (!wa.bind) continue;
    checkBind(`whatsapp[${i}]`, wa.id, wa.bind, wa.id ?? `whatsapp[${i}]`);
  }
  for (const [i, vb] of (config.voice?.bots ?? []).entries()) {
    // Voice bots have no token — derive the botKey from the explicit id or the
    // room/number `match` seed (same primitive every adapter/config uses).
    checkBind(`voice.bots[${i}]`, vb.id, vb.bind, vb.id ?? deriveBotKeyFromSeed(vb.match));
  }
  for (const name of Object.keys(config.teams ?? {})) {
    rejectUnsafeIdent(`teams.<key>`, name, errors);
  }
  return errors;
}
