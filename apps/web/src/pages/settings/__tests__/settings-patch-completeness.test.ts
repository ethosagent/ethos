import { describe, expect, it } from 'vitest';
import { buildConfigPatch, type SettingsRows } from '../lib/build-config-patch';
import type { RetentionSubkey } from '../lib/config-types';
import type { FormShape } from '../lib/form-shape';
import { emptyRow, type ProviderRow, rowsFromConfig } from '../lib/rows';

// T2 — plan/phases/settings-navigation.md §5 and §10.
//
// The BEHAVIOURAL half of the invariant T1 guards structurally. `onFinish` reads
// `form.getFieldsValue(true)` — the whole store, including fields whose panes
// are unmounted — and the builder maps ~100 of them through `values.x ?? null`.
// `null` is a CLEAR in `config.update`, so a value MISSING from the store is not
// a skipped update: it is a deletion. Saving from Memory would wipe the trunk
// credentials, silently.
//
// Two assertions, and the second is the one that matters:
//
//   1. A store carrying keys from three different categories emits all three —
//      the cross-category save works, which is what the two-pane shape needs.
//   2. A store MISSING a key emits neither the key nor an explicit `null` for
//      it — absence means "that pane never mounted", never "the user cleared
//      it". This fails even if a refactor invents a structure T1 does not
//      recognise, which is the whole reason the guard is doubled.

/** A complete, valid store — every category represented, nothing exotic. */
function store(): FormShape {
  return {
    // General
    personality: 'engineer',
    skin: 'ethos',
    // Memory
    memory: 'markdown',
    memoryNotices: true,
    memoryConsolidationEnabled: false,
    memoryCaptureEnabled: false,
    memoryCaptureModel: '',
    memoryVault: { path: '', agentDir: '', prefetch: [], exclude: [] },
    memoryApproval: { mode: 'off', cap: null, ttlDays: null },
    memoryConsolidation: {
      halfLifeDays: null,
      threshold: null,
      exemptUser: true,
      flushThreshold: null,
      timeboxMs: null,
      maxTokens: null,
      maxDeltaChars: null,
      minMessagesSinceFlush: null,
    },
    memoryCapture: { provider: '', apiKey: '', baseUrl: '', maxPerHour: null, maxPerDay: null },
    memoryCharLimits: { memory: 524_288, user: 524_288 },
    // Security & access
    approvalMode: 'smart',
    adminEnabled: false,
    gatewayMaxInboundMediaBytes: null,
    // Chat & context
    verbosity: 'balanced',
    streamingEdits: 'dms',
    contextLayering: false,
    autoCompact: true,
    compaction: {
      pressure: null,
      target: null,
      gateDelta: null,
      retryOnOverflow: true,
      abortOnSummaryFailure: false,
      smallWindow: 'auto',
    },
    displayVerbosity: 'default',
    displayBusyInputMode: 'interrupt',
    displayToolPreviewLength: null,
    displayResumeHint: true,
    displayResumeRecapTurns: null,
    displayBellOnComplete: false,
    discordMissedMessageBackfill: { enabled: true, windowSeconds: null, limit: 50 },
    // Developer
    debugMode: false,
    debugPanelEnabled: false,
    debugPanelModel: '',
    logsRotation: { enabled: true, maxBytes: null, maxFiles: null },
    logsLevel: 'debug',
    executionDocker: { cpu: 2, diskMb: null },
    executionSsh: {
      host: '',
      user: '',
      port: null,
      identityFile: '',
      knownHostsFile: '',
      strictHostKeys: '',
      remoteWorkdir: '',
    },
    toolLoop: { maxToolCallsWarnAt: null, maxIdenticalToolCallsWarnAt: null },
    browser: { navigationTimeoutMs: 30_000, commandTimeoutMs: 10_000 },
    pluginsAutoInstall: 'default',
    webBaseUrl: '',
    apiVersion: '',
    verbose: false,
    // Voice
    voiceEnabled: false,
    voiceChime: true,
    callStyle: 'personality',
    callAccent: 'personality',
    callAccentCustom: '',
    voiceEndpointSilenceMs: 600,
    voiceBargeThreshold: 0.05,
    voiceBargeSustainMs: 200,
    voiceSpeechThreshold: 0.02,
    voiceSpeechMinMs: 200,
    voiceProvider: '',
    voiceApiKey: '',
    voiceBaseUrl: '',
    voiceModel: '',
    voiceTtsProvider: '',
    voiceTtsApiKey: '',
    voiceTtsVoice: '',
    voiceTtsBaseUrl: '',
    voiceTtsModel: '',
    voiceSttCommand: '',
    voiceTtsCommand: '',
    voiceTtsOutputFormat: '',
    voiceTtsTimeoutMs: null,
    voiceTtsMaxTextLength: null,
    voiceSttTimeoutMs: null,
    voiceEgressGate: false,
    voiceTrustedPlugins: [],
    voiceDefaultMode: '',
    voiceChannelTtsOut: { telegram: true, slack: true, discord: true, whatsapp: true, email: true },
    voiceTranscodeFfmpegPath: '',
    voiceTranscodeBitrateKbps: null,
    voiceTranscodeTimeoutSec: null,
    voiceArtifactAbandonAfterDays: null,
    voiceArtifactMaxTotalMb: null,
    voiceTier: '',
    voiceRealtimeDefault: '',
    voiceRealtimeSessionBudgetUsd: null,
    // Voice → telephony
    voiceTrunkProvider: '',
    voiceTrunkId: '',
    voiceTrunkFromNumber: '',
    voiceTrunkUsername: '',
    voiceTrunkPassword: '',
    voiceTrunkWebhookSecret: '',
    voiceTrunkWebhookPath: '',
    voiceTrunkCodec: '',
    voiceLivekitUrl: '',
    voiceLivekitApiKey: '',
    voiceLivekitApiSecret: '',
    voiceInboundAllowlist: [],
    voiceInboundReceptionist: '',
    voiceInboundConcurrencyCap: null,
    voiceInboundPerCallerPerHour: null,
    voiceInboundDailyBudgetUsd: null,
    voiceInboundPrewarm: '',
    voiceInboundOwnerPlatform: '',
    voiceInboundOwnerChatId: '',
    voiceInboundOwnerBotKey: '',
    voiceBargeIn: {
      call: { energyThreshold: null, minSpeechMs: null, silenceMs: null },
      satellite: { energyThreshold: null, minSpeechMs: null, silenceMs: null },
    },
    voiceFiller: { enabled: true, afterMs: null, text: '', tickIntervalMs: null },
    // Background jobs
    background: {
      enabled: false,
      maxConcurrentJobs: null,
      maxJobsPerRoot: null,
      maxJobsPerPersonality: null,
      defaultMaxCostUsd: null,
      maxRootBackgroundUsd: null,
      queuedTtlMs: null,
      staleMs: null,
      heartbeatMs: null,
      retentionDays: null,
    },
    kanban: { maxInProgress: null, maxInProgressPerProfile: null },
    // Data & retention
    retentionVacuumAfterPrune: false,
    retentionMinVacuumIntervalDays: null,
    // Automation
    backup: { enabled: true, cron: '', scope: [], keep: null, dir: '' },
    nightlyPass: { enabled: false, cron: '' },
    weeklyDigest: { enabled: false, cron: '', recipients: [] },
    cronMaxParallelJobs: null,
    teamSupervisorRestartLoopGuard: { maxRestarts: 5, windowSeconds: 60 },
    // Models & providers
    modelCatalog: { enabled: true, url: '', ttlHours: null },
    webSearchBackend: '',
    webExtractBackend: '',
    auxCompression: { model: '', provider: '', apiKey: '', baseUrl: '' },
    auxVision: { model: '', provider: '', apiKey: '', baseUrl: '' },
    auxWeb: { model: '', provider: '', apiKey: '', baseUrl: '' },
  };
}

function rows(): SettingsRows {
  return {
    providerRows: [
      {
        _id: 1,
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: '',
        apiKeyPreview: 'sk-…abc1',
        baseUrl: '',
        testStatus: 'idle',
      },
    ],
    quickCommandRows: [],
    channelToolsetRows: [],
    voiceTtsProviderRows: [],
    voiceSttProviderRows: [],
    voiceRealtimeProviderRows: [],
    retentionRows: [],
    voiceBotRows: [],
  };
}

function build(values: FormShape) {
  const result = buildConfigPatch(values, rows(), undefined);
  if (!result.ok) throw new Error(`expected a patch, got: ${result.error}`);
  return result.patch as Record<string, unknown>;
}

describe('buildConfigPatch', () => {
  it('emits keys from every category, not just the one on screen', () => {
    const patch = build(store());
    // General · Memory · Voice — three panes, only one of which can be mounted.
    expect(patch.skin).toBe('ethos');
    expect(patch.memoryNotices).toBe(true);
    expect(patch.voiceChime).toBe(true);
  });

  it('skips a key the store does not carry — it does NOT clear it', () => {
    const partial = store();
    // What an unmounted General pane looks like if `preserve` ever stops holding.
    delete (partial as Partial<FormShape>).skin;

    const patch = build(partial);
    expect('skin' in patch).toBe(false);
    expect(patch.skin).not.toBeNull();
    // The categories still in the store are untouched by the omission.
    expect(patch.memoryNotices).toBe(true);
    expect(patch.voiceChime).toBe(true);
  });

  // The narrowing T5 closed. The absent-field guard keeps a patch key only
  // while `key in values` — so `backup` survives exactly because `FormShape`
  // carries it and `SettingsShell` seeds it from `config.get`. A
  // `backup.enabled` switch added without those two would have been deleted
  // here and written nothing at all.
  it('emits the backup schedule, blanks and all', () => {
    expect(build(store()).backup).toEqual({
      enabled: true,
      cron: null,
      scope: [],
      keep: null,
      dir: null,
    });
  });

  it('keeps the rows-derived keys, which have no same-named form field', () => {
    const patch = build(store());
    expect(patch.provider).toBe('anthropic');
    expect(patch.model).toBe('claude-opus-4-7');
    expect(patch.providers).toEqual([{ provider: 'anthropic', model: 'claude-opus-4-7' }]);
  });

  it('refuses a chain with no primary provider rather than saving a blank one', () => {
    const result = buildConfigPatch(store(), { ...rows(), providerRows: [] }, undefined);
    expect(result).toEqual({ ok: false, error: 'Primary provider and model are required.' });
  });
});

// F01 follow-up: a loaded provider row sends back `sourceIndex`, its position
// in `config.get`'s `providers`, so the server keeps the stored entry's key
// reference and the fields this editor does not show (`overlayProviderRow`,
// apps/web-api config.service.ts). Loading is pinned in
// `settings-provider-rows.test.ts`.
describe('buildConfigPatch — provider chain identity', () => {
  const chain = rowsFromConfig([
    { provider: 'anthropic', model: 'claude-opus-4-7', apiKeyPreview: 'sk-…abc1', baseUrl: null },
    { provider: 'bedrock', model: null, apiKeyPreview: '<unset>', baseUrl: null },
    { provider: 'azure', model: 'gpt-4o', apiKeyPreview: 'az-…9f00', baseUrl: 'https://x.az' },
  ]);

  function providers(providerRows: ProviderRow[]) {
    const result = buildConfigPatch(store(), { ...rows(), providerRows }, undefined);
    if (!result.ok) throw new Error(`expected a patch, got: ${result.error}`);
    return result.patch.providers;
  }

  it('sends each loaded row sourceIndex, in the rows current order', () => {
    const [anthropic, bedrock, azure] = chain;
    if (!anthropic || !bedrock || !azure) throw new Error('fixture chain missing');
    expect(providers([azure, anthropic, bedrock])).toEqual([
      { provider: 'azure', model: 'gpt-4o', baseUrl: 'https://x.az', sourceIndex: 2 },
      { provider: 'anthropic', model: 'claude-opus-4-7', sourceIndex: 0 },
      { provider: 'bedrock', sourceIndex: 1 },
    ]);
  });

  it('sends the chain version the rows were loaded from', () => {
    const result = buildConfigPatch(store(), { ...rows(), providerRows: chain }, undefined, {
      providersVersion: 'v-loaded',
      loadedPrimary: chain[0],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.patch.providersVersion).toBe('v-loaded');
  });

  // verify-f01: top-level `provider: anthropic` + its key, chain row 0 openai.
  // An unrelated save rewrote `provider` to openai and kept anthropic's key.
  it('leaves the top-level provider fields out when the primary row is untouched', () => {
    const result = buildConfigPatch(store(), { ...rows(), providerRows: chain }, undefined, {
      providersVersion: 'v',
      loadedPrimary: chain[0],
    });
    if (!result.ok) throw new Error(result.error);
    for (const key of ['provider', 'model', 'baseUrl', 'apiKey']) {
      expect(key in result.patch, key).toBe(false);
    }
  });

  it('writes the top-level provider fields once the primary row is edited or replaced', () => {
    const [anthropic, bedrock, azure] = chain;
    if (!anthropic || !bedrock || !azure) throw new Error('fixture chain missing');
    const base = { providersVersion: 'v', loadedPrimary: anthropic };

    const edited = buildConfigPatch(
      store(),
      { ...rows(), providerRows: [{ ...anthropic, model: 'claude-sonnet-5' }, bedrock] },
      undefined,
      base,
    );
    if (!edited.ok) throw new Error(edited.error);
    expect(edited.patch).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5' });

    const moved = buildConfigPatch(
      store(),
      { ...rows(), providerRows: [azure, anthropic] },
      undefined,
      base,
    );
    if (!moved.ok) throw new Error(moved.error);
    expect(moved.patch).toMatchObject({ provider: 'azure', model: 'gpt-4o' });
  });

  it('sends a new row without sourceIndex, and a key only where retyped', () => {
    const [anthropic] = chain;
    if (!anthropic) throw new Error('fixture chain missing');
    const added = { ...emptyRow(), provider: 'ollama', model: 'llama3' };
    expect(providers([{ ...anthropic, apiKey: 'sk-new' }, added])).toEqual([
      { provider: 'anthropic', model: 'claude-opus-4-7', apiKey: 'sk-new', sourceIndex: 0 },
      { provider: 'ollama', model: 'llama3' },
    ]);
  });
});

// `personalities.<id>.retention.channelTranscript` is a value nothing reads —
// observe-mode transcripts are one database with no personality column, pruned
// against the global key alone (`RETENTION_NO_PERSONALITY_SCOPE`,
// @ethosagent/types). `config.update` refuses it for every caller; the Settings
// page's job is to make sure the operator never has to see that refusal.
//
// The dropdowns stop a NEW row (`RETENTION_SUBKEYS_PER_PERSONALITY` in
// config-types.ts). This is the other half: a row hydrated from a line an
// EARLIER build wrote never went through a dropdown, so the builder has to
// catch it and say which row and what to do.
describe('buildConfigPatch — per-personality retention scope', () => {
  const retentionRow = (personalityId: string, subkey: RetentionSubkey) => ({
    _id: 1,
    personalityId,
    subkey,
    duration: '7d',
  });

  it('refuses a channelTranscript row scoped to a personality, naming the row', () => {
    const result = buildConfigPatch(
      store(),
      { ...rows(), retentionRows: [retentionRow('researcher', 'channelTranscript')] },
      undefined,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('channelTranscript');
    expect(result.error).toContain('researcher');
    expect(result.error).toMatch(/remove this row/i);
  });

  it('keeps the GLOBAL channelTranscript rule settable', () => {
    const result = buildConfigPatch(
      store(),
      { ...rows(), retentionRows: [retentionRow('', 'channelTranscript')] },
      undefined,
    );
    if (!result.ok) throw new Error(`expected a patch, got: ${result.error}`);
    expect(result.patch.retention).toEqual({ channelTranscript: '7d' });
    expect(result.patch.personalityRetention).toEqual({});
  });

  // Removing the row is how a stale value is cleared: `personalityRetention` is
  // a full replacement, so a save with the row gone deletes the config.yaml
  // line. That path must reach the server, not be refused on the way out.
  it('lets the save through once the stale row is removed, clearing the value', () => {
    const result = buildConfigPatch(store(), { ...rows(), retentionRows: [] }, undefined);
    if (!result.ok) throw new Error(`expected a patch, got: ${result.error}`);
    expect(result.patch.personalityRetention).toEqual({});
  });

  it('still allows every other subkey per personality', () => {
    const result = buildConfigPatch(
      store(),
      { ...rows(), retentionRows: [retentionRow('researcher', 'messages')] },
      undefined,
    );
    if (!result.ok) throw new Error(`expected a patch, got: ${result.error}`);
    expect(result.patch.personalityRetention).toEqual({ researcher: { messages: '7d' } });
  });
});
