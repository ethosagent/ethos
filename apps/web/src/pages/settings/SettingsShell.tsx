// The Settings route element. It NEVER unmounts while you are on the surface.
//
// THE INVARIANT (plan/phases/settings-navigation.md §5.3, quoted so it can be
// quoted back in review):
//
//   The `<Form>` element must enclose the `<Outlet/>`. A pane must never create
//   a form instance for page-Save-backed fields, and `preserve` must never be
//   set to `false`.
//
// Why, concretely. `onFinish` reads `form.getFieldsValue(true)` — the WHOLE
// store, including fields whose `Form.Item` is currently unmounted. That works
// because (a) this `<Form>` mounts once and never remounts, (b) `preserve` is
// unset and therefore `true` (`@rc-component/form/lib/hooks/useForm.js:524`,
// `mergedPreserve ?? true`), so an unmounting `Form.Item` leaves its value in
// the store. Routing the panes grew the unmounted set from "the advanced blocks"
// to "every field outside the category on screen", and the patch builder maps
// ~100 fields through `values.x ?? null` — so a missing value is not a skipped
// update, it is an explicit `null`, which is a CLEAR. Move the `<Form>` inside a
// pane and saving from Memory silently deletes the trunk credentials.
//
// Guarded by `__tests__/settings-form-placement.test.ts` (structure) and
// `__tests__/settings-patch-completeness.test.ts` (behaviour).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Form, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { LoadingState } from '../../components/ui/LoadingState';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { isDesktop } from '../../lib/desktop';
import { errorCode } from '../../lib/recipes';
import { rpc } from '../../rpc';
import { CategoryRail } from './CategoryRail';
import { buildConfigPatch, type SettingsRows } from './lib/build-config-patch';
import type { ConfigUpdatePatch } from './lib/config-types';
import { auxFormFromConfig, type FormShape } from './lib/form-shape';
import { modelRegistryKeys } from './lib/model-registry';
import { parseSettingsPath } from './lib/parse-settings-path';
import { resolveSettingsRoute } from './lib/resolve-settings-route';
import {
  type ChannelToolsetRow,
  channelToolsetRowsFromConfig,
  type QuickCommandRow,
  quickCommandRowsFromConfig,
  type RetentionRow,
  retentionRowsFromConfig,
} from './lib/rows';
import { type SectionRoute, shouldScrollToSection } from './lib/section-scroll';
import { computeDirty, type DirtySnapshot } from './lib/settings-dirty';
import { visibleCategories } from './lib/taxonomy';
import { type VoiceBotRow, voiceBotRowsFromConfig } from './lib/voice-bots';
import {
  CALL_ACCENT_CUSTOM,
  isCallAccentPreset,
  voiceChannelTtsOutFromConfig,
} from './lib/voice-options';
import {
  type VoiceProviderRow,
  voiceRealtimeProviderRowsFromConfig,
  voiceSttProviderRowsFromConfig,
  voiceTtsProviderRowsFromConfig,
} from './lib/voice-roster';
import { voiceBargeInFromConfig } from './lib/voice-telephony';
import type { SettingsPaneContext } from './pane-context';
import { SaveBar } from './SaveBar';
import './settings-ux.css';

export function SettingsShell() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const { pathname } = useLocation();
  const [form] = Form.useForm<FormShape>();
  const [quickCommandRows, setQuickCommandRows] = useState<QuickCommandRow[]>([]);
  const [channelToolsetRows, setChannelToolsetRows] = useState<ChannelToolsetRow[]>([]);
  const [voiceTtsProviderRows, setVoiceTtsProviderRows] = useState<VoiceProviderRow[]>([]);
  const [voiceSttProviderRows, setVoiceSttProviderRows] = useState<VoiceProviderRow[]>([]);
  const [voiceRealtimeProviderRows, setVoiceRealtimeProviderRows] = useState<VoiceProviderRow[]>(
    [],
  );
  const [retentionRows, setRetentionRows] = useState<RetentionRow[]>([]);
  const [voiceBotRows, setVoiceBotRows] = useState<VoiceBotRow[]>([]);
  const hydratedRef = useRef(false);
  // What hydration last wrote — the left-hand side of the dirty diff (D9).
  const [saved, setSaved] = useState<DirtySnapshot | null>(null);
  // The form store mutates outside React, so nothing re-renders when a field
  // changes. This counter is what makes the derived dirty count live.
  const [storeRevision, setStoreRevision] = useState(0);
  // B2 (web save half): the config parser's warnings for the file as it
  // stands — seeded from `config.get`, replaced by every save's response.
  const [saveWarnings, setSaveWarnings] = useState<string[]>([]);

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => rpc.config.get(),
  });

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
  });

  // Hydrate the form whenever config data arrives or refreshes, and the rows on
  // first load and after a save. Providers are not here: they save on confirm
  // through `modelRegistry.*` and are read from `modelRegistry.list`.
  useEffect(() => {
    if (configQuery.data) {
      // Version skew: an older backend's `config.get` predates `resolved`, and
      // the contract type being required does not make the wire honest —
      // feature-detect rather than crash the whole Settings surface.
      setSaveWarnings(configQuery.data.resolved?.warnings ?? []);
      const hydrated: FormShape = {
        personality: configQuery.data.personality,
        memory: configQuery.data.memory,
        skin: configQuery.data.skin,
        approvalMode: configQuery.data.approvalMode,
        verbosity: configQuery.data.verbosity,
        debugMode: configQuery.data.debugMode,
        contextLayering: configQuery.data.contextLayering,
        debugPanelEnabled: configQuery.data.debugPanelEnabled,
        debugPanelModel: configQuery.data.debugPanelModel ?? '',
        adminEnabled: configQuery.data.adminEnabled,
        streamingEdits: configQuery.data.streamingEdits,
        autoCompact: configQuery.data.autoCompact,
        memoryConsolidationEnabled: configQuery.data.memoryConsolidationEnabled,
        memoryCaptureEnabled: configQuery.data.memoryCaptureEnabled,
        memoryCaptureModel: configQuery.data.memoryCaptureModel ?? '',
        memoryNotices: configQuery.data.memoryNotices,
        voiceEnabled: Boolean(configQuery.data.voiceProvider),
        voiceChime: configQuery.data.voiceChime,
        callStyle: configQuery.data.callStyle,
        // A hex the presets do not cover lands in the custom field, so a
        // hand-edited config.yaml survives a round trip through this form.
        callAccent: isCallAccentPreset(configQuery.data.callAccent)
          ? configQuery.data.callAccent
          : CALL_ACCENT_CUSTOM,
        callAccentCustom: isCallAccentPreset(configQuery.data.callAccent)
          ? ''
          : configQuery.data.callAccent,
        voiceEndpointSilenceMs: configQuery.data.voiceEndpointSilenceMs,
        voiceBargeThreshold: configQuery.data.voiceBargeThreshold,
        voiceBargeSustainMs: configQuery.data.voiceBargeSustainMs,
        voiceSpeechThreshold: configQuery.data.voiceSpeechThreshold,
        voiceSpeechMinMs: configQuery.data.voiceSpeechMinMs,
        voiceProvider: configQuery.data.voiceProvider ?? '',
        voiceApiKey: '',
        voiceBaseUrl: configQuery.data.voiceBaseUrl ?? '',
        voiceModel: configQuery.data.voiceModel ?? '',
        voiceTtsProvider: configQuery.data.voiceTtsProvider ?? '',
        voiceTtsApiKey: '',
        voiceTtsVoice: configQuery.data.voiceTtsVoice ?? '',
        voiceTtsBaseUrl: configQuery.data.voiceTtsBaseUrl ?? '',
        voiceTtsModel: configQuery.data.voiceTtsModel ?? '',
        voiceSttCommand: configQuery.data.voiceSttCommand ?? '',
        voiceTtsCommand: configQuery.data.voiceTtsCommand ?? '',
        voiceTtsOutputFormat: configQuery.data.voiceTtsOutputFormat ?? '',
        voiceTtsTimeoutMs: configQuery.data.voiceTtsTimeoutMs,
        voiceTtsMaxTextLength: configQuery.data.voiceTtsMaxTextLength,
        voiceSttTimeoutMs: configQuery.data.voiceSttTimeoutMs,
        voiceEgressGate: configQuery.data.voiceTrustedPlugins !== null,
        voiceTrustedPlugins: configQuery.data.voiceTrustedPlugins ?? [],
        voiceDefaultMode: configQuery.data.voiceDefaultMode ?? '',
        voiceChannelTtsOut: voiceChannelTtsOutFromConfig(configQuery.data.voiceChannelTtsOut),
        voiceTranscodeFfmpegPath: configQuery.data.voiceTranscodeFfmpegPath ?? '',
        voiceTranscodeBitrateKbps: configQuery.data.voiceTranscodeBitrateKbps,
        voiceTranscodeTimeoutSec: configQuery.data.voiceTranscodeTimeoutSec,
        voiceArtifactAbandonAfterDays: configQuery.data.voiceArtifactAbandonAfterDays,
        voiceArtifactMaxTotalMb: configQuery.data.voiceArtifactMaxTotalMb,
        voiceTier: configQuery.data.voiceTier ?? '',
        voiceRealtimeDefault: configQuery.data.voiceRealtimeDefault ?? '',
        voiceRealtimeSessionBudgetUsd: configQuery.data.voiceRealtimeSessionBudgetUsd,
        // Telephony. The four secret fields hydrate BLANK on purpose — blank
        // means "keep what is stored", and the previews are shown beside them.
        voiceTrunkProvider: configQuery.data.voiceTrunkProvider ?? '',
        voiceTrunkId: configQuery.data.voiceTrunkId ?? '',
        voiceTrunkFromNumber: configQuery.data.voiceTrunkFromNumber ?? '',
        voiceTrunkUsername: configQuery.data.voiceTrunkUsername ?? '',
        voiceTrunkPassword: '',
        voiceTrunkWebhookSecret: '',
        voiceTrunkWebhookPath: configQuery.data.voiceTrunkWebhookPath ?? '',
        voiceTrunkCodec: configQuery.data.voiceTrunkCodec ?? '',
        voiceLivekitUrl: configQuery.data.voiceLivekitUrl ?? '',
        voiceLivekitApiKey: '',
        voiceLivekitApiSecret: '',
        voiceInboundAllowlist: configQuery.data.voiceInboundAllowlist ?? [],
        voiceInboundReceptionist: configQuery.data.voiceInboundReceptionist ?? '',
        voiceInboundConcurrencyCap: configQuery.data.voiceInboundConcurrencyCap,
        voiceInboundPerCallerPerHour: configQuery.data.voiceInboundPerCallerPerHour,
        voiceInboundDailyBudgetUsd: configQuery.data.voiceInboundDailyBudgetUsd,
        voiceInboundPrewarm: configQuery.data.voiceInboundPrewarm ?? '',
        voiceInboundOwnerPlatform: configQuery.data.voiceInboundOwnerPlatform ?? '',
        voiceInboundOwnerChatId: configQuery.data.voiceInboundOwnerChatId ?? '',
        voiceInboundOwnerBotKey: configQuery.data.voiceInboundOwnerBotKey ?? '',
        voiceBargeIn: voiceBargeInFromConfig(configQuery.data.voiceBargeIn),
        displayVerbosity: configQuery.data.displayVerbosity,
        displayBusyInputMode: configQuery.data.displayBusyInputMode,
        displayToolPreviewLength: configQuery.data.displayToolPreviewLength,
        displayResumeHint: configQuery.data.displayResumeHint,
        displayResumeRecapTurns: configQuery.data.displayResumeRecapTurns,
        displayBellOnComplete: configQuery.data.displayBellOnComplete,
        compaction: { ...configQuery.data.compaction },
        voiceFiller: {
          ...configQuery.data.voiceFiller,
          text: configQuery.data.voiceFiller.text ?? '',
        },
        memoryVault: {
          path: configQuery.data.memoryVault.path ?? '',
          agentDir: configQuery.data.memoryVault.agentDir ?? '',
          prefetch: configQuery.data.memoryVault.prefetch,
          exclude: configQuery.data.memoryVault.exclude,
        },
        memoryApproval: { ...configQuery.data.memoryApproval },
        memoryConsolidation: { ...configQuery.data.memoryConsolidation },
        memoryCapture: {
          provider: configQuery.data.memoryCapture.provider ?? '',
          apiKey: '',
          baseUrl: configQuery.data.memoryCapture.baseUrl ?? '',
          maxPerHour: configQuery.data.memoryCapture.maxPerHour,
          maxPerDay: configQuery.data.memoryCapture.maxPerDay,
        },
        background: { ...configQuery.data.background },
        backup: {
          enabled: configQuery.data.backup.enabled,
          cron: configQuery.data.backup.cron ?? '',
          scope: configQuery.data.backup.scope,
          keep: configQuery.data.backup.keep,
          dir: configQuery.data.backup.dir ?? '',
        },
        nightlyPass: { ...configQuery.data.nightlyPass },
        weeklyDigest: { ...configQuery.data.weeklyDigest },
        modelCatalog: {
          enabled: configQuery.data.modelCatalog.enabled,
          url: configQuery.data.modelCatalog.url ?? '',
          ttlHours: configQuery.data.modelCatalog.ttlHours,
        },
        logsRotation: { ...configQuery.data.logsRotation },
        logsLevel: configQuery.data.logsLevel,
        retentionVacuumAfterPrune: configQuery.data.retentionVacuumAfterPrune,
        retentionMinVacuumIntervalDays: configQuery.data.retentionMinVacuumIntervalDays,
        memoryCharLimits: { ...configQuery.data.memoryCharLimits },
        executionDocker: { ...configQuery.data.executionDocker },
        executionSsh: {
          host: configQuery.data.executionSsh.host ?? '',
          user: configQuery.data.executionSsh.user ?? '',
          port: configQuery.data.executionSsh.port,
          identityFile: configQuery.data.executionSsh.identityFile ?? '',
          knownHostsFile: configQuery.data.executionSsh.knownHostsFile ?? '',
          strictHostKeys: configQuery.data.executionSsh.strictHostKeys ?? '',
          remoteWorkdir: configQuery.data.executionSsh.remoteWorkdir ?? '',
        },
        toolLoop: { ...configQuery.data.toolLoop },
        browser: { ...configQuery.data.browser },
        kanban: { ...configQuery.data.kanban },
        cronMaxParallelJobs: configQuery.data.cronMaxParallelJobs,
        gatewayMaxInboundMediaBytes: configQuery.data.gatewayMaxInboundMediaBytes,
        teamSupervisorRestartLoopGuard: { ...configQuery.data.teamSupervisorRestartLoopGuard },
        discordMissedMessageBackfill: { ...configQuery.data.discordMissedMessageBackfill },
        webSearchBackend: configQuery.data.webSearchBackend ?? '',
        webExtractBackend: configQuery.data.webExtractBackend ?? '',
        auxCompression: auxFormFromConfig(configQuery.data.auxCompression),
        auxVision: auxFormFromConfig(configQuery.data.auxVision),
        auxWeb: auxFormFromConfig(configQuery.data.auxWeb),
        apiVersion: configQuery.data.apiVersion ?? '',
        verbose: configQuery.data.verbose,
        pluginsAutoInstall:
          configQuery.data.pluginsAutoInstall === null
            ? 'default'
            : configQuery.data.pluginsAutoInstall
              ? 'on'
              : 'off',
        webBaseUrl: configQuery.data.webBaseUrl ?? '',
      };
      form.setFieldsValue(hydrated);
      // Rows rebuild on first load and after a save or a refused save.
      if (!hydratedRef.current) {
        const hydratedRows: SettingsRows = {
          quickCommandRows: quickCommandRowsFromConfig(configQuery.data.quickCommands),
          channelToolsetRows: channelToolsetRowsFromConfig(configQuery.data.channelToolsets),
          voiceTtsProviderRows: voiceTtsProviderRowsFromConfig(configQuery.data.voiceTtsProviders),
          voiceSttProviderRows: voiceSttProviderRowsFromConfig(configQuery.data.voiceSttProviders),
          voiceRealtimeProviderRows: voiceRealtimeProviderRowsFromConfig(
            configQuery.data.voiceRealtimeProviders,
          ),
          retentionRows: retentionRowsFromConfig(
            configQuery.data.retention,
            configQuery.data.personalityRetention,
          ),
          voiceBotRows: voiceBotRowsFromConfig(configQuery.data.voiceBots),
        };
        setQuickCommandRows(hydratedRows.quickCommandRows);
        setChannelToolsetRows(hydratedRows.channelToolsetRows);
        setVoiceTtsProviderRows(hydratedRows.voiceTtsProviderRows);
        setVoiceSttProviderRows(hydratedRows.voiceSttProviderRows);
        setVoiceRealtimeProviderRows(hydratedRows.voiceRealtimeProviderRows);
        setRetentionRows(hydratedRows.retentionRows);
        setVoiceBotRows(hydratedRows.voiceBotRows);
        hydratedRef.current = true;
        // The snapshot the dirty diff reads from. Set with the rows rather than
        // on every payload, so the two halves it compares always come from the
        // same `config.get` — a values-only refresh would make a row edit made
        // since the last save read as saved.
        setSaved({ values: hydrated, rows: hydratedRows });
      }
    }
  }, [configQuery.data, form]);

  const updateMut = useMutation({
    mutationFn: (patch: ConfigUpdatePatch) => rpc.config.update(patch),
    onSuccess: (data) => {
      // B2: the save response reports the unknown keys the write kept.
      setSaveWarnings(data.warnings ?? []);
      qc.invalidateQueries({ queryKey: ['config'] });
      qc.invalidateQueries({ queryKey: ['meta', 'capabilities'] });
      // The page Save writes no providers, but it rewrites config.yaml, which
      // is what `modelRegistry.list` reads.
      qc.invalidateQueries({ queryKey: modelRegistryKeys.all() });
      hydratedRef.current = false;
      notification.success({ message: 'Settings saved', placement: 'topRight' });
    },
    onError: (err) => {
      if (errorCode(err) === 'CONFIG_CONFLICT') {
        // The provider chain changed in another tab or through the CLI. The
        // save was refused and nothing was written; reload rather than
        // overwrite what the other writer did.
        hydratedRef.current = false;
        qc.invalidateQueries({ queryKey: ['config'] });
        notification.warning({
          message: 'Settings changed elsewhere',
          description:
            'The provider chain was changed in another tab or by the CLI, so nothing was saved. Settings have been reloaded — check them and save again.',
          placement: 'topRight',
        });
        return;
      }
      notification.error({ message: 'Save failed', description: (err as Error).message });
    },
  });

  // Above the early returns, because it is a hook. Recomputed whenever a field
  // or a row set moves: `storeRevision` is the dependency that makes a keystroke
  // count, since the form store mutates outside React and nothing else here
  // would notice.
  // biome-ignore lint/correctness/useExhaustiveDependencies: storeRevision is the change signal for `form`'s external store.
  const dirty = useMemo(
    () =>
      computeDirty(saved, form.getFieldsValue(true), {
        quickCommandRows,
        channelToolsetRows,
        voiceTtsProviderRows,
        voiceSttProviderRows,
        voiceRealtimeProviderRows,
        retentionRows,
        voiceBotRows,
      }),
    [
      saved,
      form,
      storeRevision,
      quickCommandRows,
      channelToolsetRows,
      voiceTtsProviderRows,
      voiceSttProviderRows,
      voiceRealtimeProviderRows,
      retentionRows,
      voiceBotRows,
    ],
  );

  // N5a — hold in-app navigation and unload while the form differs from what
  // hydration last wrote. Above the early returns because it is a hook.
  useUnsavedGuard(dirty.count > 0);

  // The rail's active row comes from the URL, not from the child route: a layout
  // route's `useParams` only sees the params its OWN path declares, and
  // `:category` belongs to the child. Computed above the early returns (and
  // not just where it's consumed) because the scroll effect below needs it on
  // every render, in the same hook order, regardless of loading/error state.
  const { category, section } = parseSettingsPath(pathname);
  const categories = visibleCategories(isDesktop);
  const resolved = resolveSettingsRoute({ category, section }, categories);

  // Scroll the active section's heading into view when the section changes
  // via a same-category link (e.g. a RailSearch result) — but never on mount
  // or a category switch (`shouldScrollToSection`). `.app-main` is the page's
  // actual scroll container (`overflow: auto` in styles.css); `.settings__detail`
  // itself does not scroll.
  const prevSectionRouteRef = useRef<SectionRoute | undefined>(undefined);
  useEffect(() => {
    const prev = prevSectionRouteRef.current;
    const next: SectionRoute = { category: resolved.category, section: resolved.section };
    const shouldScroll = shouldScrollToSection(prev, next);
    prevSectionRouteRef.current = next;
    if (!shouldScroll) return;

    const target = document.getElementById(next.section);
    const container = document.querySelector<HTMLElement>('.app-main');
    if (!target || !container) return;

    // There's no sticky nav to clear anymore, so the target heading just
    // needs to land near the container's top edge.
    const containerTop = container.getBoundingClientRect().top;
    const delta = target.getBoundingClientRect().top - containerTop - 8;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    container.scrollBy({ top: delta, behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [resolved.category, resolved.section]);

  if (configQuery.isLoading) {
    return <LoadingState label="Loading config…" />;
  }
  if (configQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load config: {(configQuery.error as Error).message}
      </Typography.Text>
    );
  }

  const personalities = personalitiesQuery.data?.items ?? [];

  const onFinish = () => {
    // PANE ROUTING is why this reads the whole store. The panes mount and
    // unmount as you navigate, so at submit time most of the 128 fields have no
    // mounted `Form.Item`; `getFieldsValue(true)` reads the WHOLE store rather
    // than the registered-field subset, and `preserve` (unset, therefore true)
    // is what left the unmounted values in it. Both halves are load-bearing —
    // see the invariant at the top of this file.
    //
    // It is worth naming what is NO LONGER a reason: advanced controls used to
    // unmount behind `{showAdvanced && …}`, and that was the original argument
    // for `getFieldsValue(true)`. They always render now and stay mounted, so
    // that argument is gone and routing is the whole of it. The call does not
    // change — routing unmounts far more than the advanced blocks ever did.
    const values: FormShape = form.getFieldsValue(true);
    const built = buildConfigPatch(
      values,
      {
        quickCommandRows,
        channelToolsetRows,
        voiceTtsProviderRows,
        voiceSttProviderRows,
        voiceRealtimeProviderRows,
        retentionRows,
        voiceBotRows,
      },
      configQuery.data,
    );
    if (!built.ok) {
      notification.error({ message: built.error });
      return;
    }
    updateMut.mutate(built.patch);
  };

  const paneContext: SettingsPaneContext = {
    form,
    config: configQuery.data,
    personalities,
    personalitiesLoading: personalitiesQuery.isLoading,
    quickCommandRows,
    setQuickCommandRows,
    channelToolsetRows,
    setChannelToolsetRows,
    voiceTtsProviderRows,
    setVoiceTtsProviderRows,
    voiceSttProviderRows,
    setVoiceSttProviderRows,
    voiceRealtimeProviderRows,
    setVoiceRealtimeProviderRows,
    retentionRows,
    setRetentionRows,
    voiceBotRows,
    setVoiceBotRows,
  };

  return (
    <div className="settings-tab">
      <header className="settings-toolbar">
        <Typography.Title level={4} style={{ margin: 0 }}>
          Settings
        </Typography.Title>
      </header>

      <div className="settings">
        <CategoryRail
          categories={categories}
          activeCategory={resolved.category}
          dirtyCategories={dirty.categories}
        />
        <div className="settings__detail">
          {/*
            `component={false}` renders NO `<form>` node (D2). Two live defects
            without it: the self-saving sections (named secrets, API keys,
            web-search defaults, A2A, Desktop) now render INSIDE this form, so
            pressing Enter in a name field would submit the page and write ~107
            config keys as a side effect of typing; and `ApiKeysSection` owns a
            modal-local `Form.useForm`, which would nest forms. Save is an
            explicit `form.submit()` from the save bar instead.
          */}
          <Form<FormShape>
            form={form}
            layout="vertical"
            component={false}
            onFinish={onFinish}
            onValuesChange={() => setStoreRevision((r) => r + 1)}
          >
            <Outlet context={paneContext} />
          </Form>
          <SaveBar
            loading={updateMut.isPending}
            onSave={() => form.submit()}
            dirty={dirty}
            categories={categories}
            warnings={saveWarnings}
          />
        </div>
      </div>
    </div>
  );
}
