import { describe, expect, it } from 'vitest';
import type {
  AuxModelGetResult,
  AuxModelUpdateInput,
  ConfigGetResult,
  ConfigServiceOptions,
  ConfigUpdateInput,
  ConfigUpdateResult,
  ProviderRowInput,
  QuickCommandGetResult,
  QuickCommandUpdateInput,
  RetentionSubkey,
  VoiceBargeInSurface,
  VoiceBargeInTuningResult,
  VoiceBargeInTuningUpdate,
  VoiceBotGetResult,
  VoiceBotUpdateInput,
  VoiceFillerGetResult,
  VoiceFillerUpdate,
  VoiceProviderGetResult,
  VoiceProviderUpdateInput,
  VoiceRealtimeProviderGetResult,
  VoiceRealtimeProviderUpdateInput,
  VoiceSttProviderGetResult,
  VoiceSttProviderUpdateInput,
  WebhookGetResult,
  WebhookUpdateInput,
} from '../../services/config.service';

// Compile-time pin: every type-only export of config.service.ts must stay
// importable from it, whichever sibling module owns the declaration
// (`pnpm typecheck`).
export type ConfigServiceTypeSurface = [
  AuxModelGetResult,
  AuxModelUpdateInput,
  ConfigGetResult,
  ConfigServiceOptions,
  ConfigUpdateInput,
  ConfigUpdateResult,
  ProviderRowInput,
  QuickCommandGetResult,
  QuickCommandUpdateInput,
  RetentionSubkey,
  VoiceBargeInSurface,
  VoiceBargeInTuningResult,
  VoiceBargeInTuningUpdate,
  VoiceBotGetResult,
  VoiceBotUpdateInput,
  VoiceFillerGetResult,
  VoiceFillerUpdate,
  VoiceProviderGetResult,
  VoiceProviderUpdateInput,
  VoiceRealtimeProviderGetResult,
  VoiceRealtimeProviderUpdateInput,
  VoiceSttProviderGetResult,
  VoiceSttProviderUpdateInput,
  WebhookGetResult,
  WebhookUpdateInput,
];

describe('config.service.ts export surface', () => {
  it('exports exactly the pre-split runtime names', async () => {
    const mod = await import('../../services/config.service');
    expect(Object.keys(mod).sort()).toEqual([
      'ConfigService',
      'VOICE_BARGE_IN_SURFACES',
      'chainImportSource',
      'providerChainSecretRefs',
      'readLegacyBrowserBargeInTuning',
      'redactKey',
      'topLevelChainEntry',
      'topLevelChainSecretRefs',
    ]);
  });
});
