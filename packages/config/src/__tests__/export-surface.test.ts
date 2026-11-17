import { describe, expect, it } from 'vitest';
import type {
  ActiveContext,
  AdoptedModel,
  AuxiliaryCompressionConfig,
  AuxiliaryVisionConfig,
  AuxiliaryWebConfig,
  AwsConfig,
  AwsSecretsConfig,
  BackgroundConfig,
  BotBinding,
  BotBudgetConfig,
  CatalogModelFacts,
  CatalogModelLookup,
  ChainModelCandidate,
  ChainModelImportOptions,
  ChainModelImportPlan,
  ChainModelImportSource,
  CronTopLevelConfig,
  DecisionProviderName,
  DecisionSiteId,
  DecisionSiteMode,
  DecisionsConfig,
  EffectiveConfig,
  EngineAskToolSetting,
  EthosConfig,
  KeyProfile,
  LearningReplaySettings,
  LoadedConfig,
  MemoryApprovalConfig,
  MemoryCaptureConfig,
  MemoryConsolidationConfig,
  MemoryVaultConfig,
  ModelCatalogConfig,
  ModelRegistryProblem,
  ModelRegistryProblemCode,
  NotificationsConfig,
  PersonalityDecisionSiteReason,
  PersonalityDecisionsInput,
  PersonalityToolSettings,
  PluginIsolationConfig,
  PluginIsolationMode,
  ProviderChainEntry,
  ProviderConfig,
  QuickCommandConfig,
  ResolvedDecisionSite,
  ResolvedDecisionsConfig,
  SearchConsoleToolSetting,
  SecretRefContext,
  SlackAppConfig,
  TeamRuntimeConfig,
  TelegramBotConfig,
  TelemetryConfig,
  TelemetryExportConfig,
  TelemetryLangfuseExportConfig,
  TelemetryOtlpExportConfig,
  ToolLoadingMode,
  ToolSettingsMap,
  VoiceBargeInConfig,
  VoiceBargeInSurface,
  VoiceBargeInTuning,
  VoiceBotConfig,
  VoiceFillerConfig,
  VoiceInboundConfig,
  VoiceLiveKitConfig,
  VoiceTrunkConfig,
  WakeRouteConfig,
  WebConfig,
  WebhookDeliveryTargetConfig,
  WebhookHmacConfig,
  WebhookHookConfig,
  WebhookRateLimitConfig,
  WebSearchToolSetting,
  WhatsAppConfig,
  XSearchToolSetting,
  YouTubeToolSetting,
} from '../index';
import {
  adoptConfigNotices,
  configParseNotices,
  parseConfigYaml,
  resolveEffectiveConfig,
} from '../index';
import surface from './fixtures/export-surface.json';

// Compile-time pin: every type-only export of index.ts must stay importable
// from it, whichever sibling module owns the declaration (`pnpm typecheck`).
export type ConfigTypeSurface = [
  ActiveContext,
  AdoptedModel,
  AuxiliaryCompressionConfig,
  AuxiliaryVisionConfig,
  AuxiliaryWebConfig,
  AwsConfig,
  AwsSecretsConfig,
  BackgroundConfig,
  BotBinding,
  BotBudgetConfig,
  CatalogModelFacts,
  CatalogModelLookup,
  ChainModelCandidate,
  ChainModelImportOptions,
  ChainModelImportPlan,
  ChainModelImportSource,
  CronTopLevelConfig,
  DecisionProviderName,
  DecisionSiteId,
  DecisionSiteMode,
  DecisionsConfig,
  EffectiveConfig,
  EngineAskToolSetting,
  EthosConfig,
  KeyProfile,
  LearningReplaySettings,
  LoadedConfig,
  MemoryApprovalConfig,
  MemoryCaptureConfig,
  MemoryConsolidationConfig,
  MemoryVaultConfig,
  ModelCatalogConfig,
  ModelRegistryProblem,
  ModelRegistryProblemCode,
  NotificationsConfig,
  PersonalityDecisionSiteReason,
  PersonalityDecisionsInput,
  PersonalityToolSettings,
  PluginIsolationConfig,
  PluginIsolationMode,
  ProviderChainEntry,
  ProviderConfig,
  QuickCommandConfig,
  ResolvedDecisionSite,
  ResolvedDecisionsConfig,
  SearchConsoleToolSetting,
  SecretRefContext,
  SlackAppConfig,
  TeamRuntimeConfig,
  TelegramBotConfig,
  TelemetryConfig,
  TelemetryExportConfig,
  TelemetryLangfuseExportConfig,
  TelemetryOtlpExportConfig,
  ToolLoadingMode,
  ToolSettingsMap,
  VoiceBargeInConfig,
  VoiceBargeInSurface,
  VoiceBargeInTuning,
  VoiceBotConfig,
  VoiceFillerConfig,
  VoiceInboundConfig,
  VoiceLiveKitConfig,
  VoiceTrunkConfig,
  WakeRouteConfig,
  WebConfig,
  WebSearchToolSetting,
  WebhookDeliveryTargetConfig,
  WebhookHmacConfig,
  WebhookHookConfig,
  WebhookRateLimitConfig,
  WhatsAppConfig,
  XSearchToolSetting,
  YouTubeToolSetting,
];

describe('packages/config export surface', () => {
  it('export surface is unchanged', async () => {
    const mod = await import('../index');
    expect(Object.keys(mod).sort()).toEqual(surface);
  });
});

// The parse-notice side-tables (`parseErrorsByConfig`, `parseWarningsByConfig`)
// have one owner; a split that left the writer (`parseConfigYaml`) and the
// reader (`configParseNotices`) holding two copies would drop every notice.
describe('config parse notices', () => {
  it('notices survive module split', () => {
    const cfg = parseConfigYaml(
      [
        'schemaVersion: 1',
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personalty: engineer',
      ].join('\n'),
    );
    expect(configParseNotices(cfg).warnings).toContain(
      "config.yaml:5 unknown key 'personalty' — did you mean 'personality'?",
    );
  });

  // `personalityDefaultedByConfig` (WeakSet, notices.ts) is written by
  // parseConfigYaml (parse.ts), carried by adoptConfigNotices (notices.ts) and
  // read by resolveEffectiveConfig (effective.ts). Two copies would turn the
  // parser's default into a file-chosen `source: 'personality'`.
  it('personality-defaulted notice survives module split', () => {
    const base = ['schemaVersion: 1', 'provider: anthropic', 'model: m', 'apiKey: sk'];
    const defaulted = parseConfigYaml(base.join('\n'));
    expect(defaulted.personality).toBeTruthy();
    expect(resolveEffectiveConfig(defaulted, {}).personality.source).toBe('default');

    const copy: EthosConfig = { ...defaulted };
    adoptConfigNotices(copy, defaulted);
    expect(resolveEffectiveConfig(copy, {}).personality.source).toBe('default');

    const chosen = parseConfigYaml([...base, 'personality: engineer'].join('\n'));
    expect(resolveEffectiveConfig(chosen, {}).personality).toMatchObject({
      id: 'engineer',
      source: 'personality',
    });
  });
});
