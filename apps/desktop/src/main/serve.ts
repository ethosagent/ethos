import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readConfig, resolveLearningReplay } from '@ethosagent/config';
import { SQLiteObservabilityStore } from '@ethosagent/observability-sqlite';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { FileSecretsResolver, FsStorage } from '@ethosagent/storage-fs';
import type { SecretsResolver, Storage } from '@ethosagent/types';
import { createWebApi } from '@ethosagent/web-api';
import type { WiringConfig } from '@ethosagent/wiring';
import {
  APPROVAL_SURFACE_ALWAYS_ASK,
  createAgentLoop,
  createApprovalDangerPredicate,
  createBrowserTakeoverRegistry,
  createLazyProvider,
  createLearningReplayer,
  createLLM,
  createSessionStore,
  IdentityMap,
} from '@ethosagent/wiring';
import { serve as honoServe } from '@hono/node-server';
import { resolveCallCaptureNativeDir, startCallCaptureDesktop } from './call-capture';
import { getKeychainValue } from './keychain';
import { type DesktopRuntime, shutdownDesktopRuntime } from './runtime-shutdown';
import { store } from './store';

let boundPort: number | null = null;
/**
 * Everything the running backend holds — HTTP server, WS lanes, call capture,
 * the web API, the loop's runtime, the sessions.db handle — released as ONE by
 * `stopServer` (F06). A restart is `stopServer` then `startServer` in this same
 * process, so what is not released here would run beside the next backend.
 */
let runtime: DesktopRuntime | null = null;

export function getDataDir(): string {
  return store.get('dataDir') ?? join(homedir(), '.ethos');
}

/**
 * Reads the shared `~/.ethos/config.yaml`'s `auxiliary.asr` / `auxiliary.tts`
 * blocks and `callCapture.personalityId`, mapping them onto the
 * `WiringConfig` fields `createAgentLoop()` / `validateCallCaptureBinding()`
 * read.
 *
 * `auxiliary.asr`/`auxiliary.tts` feed call-capture's STT provider
 * (`runCallCapture()` in `@ethosagent/tools-callcapture` fails outright —
 * "Call capture is not configured" — without one). The desktop app has never
 * read this section of the CLI's config file, so a desktop personality with
 * `call_capture` in its toolset had no STT provider even when the CLI's
 * `ethos serve` worked fine against the exact same `~/.ethos/config.yaml`.
 *
 * `callCapture.personalityId` closes a startup crash: a personality could
 * ship the `call_capture` toolset capability unconditionally (no built-in
 * currently does; a custom one might), and `validateCallCaptureBinding()`
 * throws whenever exactly one personality holds that capability and
 * `callCapture.personalityId` is unset in the effective `WiringConfig`.
 * Desktop's own `callCapturePersonalityId` store
 * field (see `store.ts`) has no Settings UI to ever set it, so without this
 * fallback a fresh desktop install — or any user who hasn't hand-edited the
 * Electron store's JSON directly — hit that throw on every startup, taking
 * down the whole backend (chat included), not just call-capture. Reading
 * `callCapture.personalityId` from here restores the same opt-in mechanism
 * the CLI (`ethos serve`/`ethos gateway`) already uses, so a user who ran
 * `ethos setup` gets consistent call-capture behavior across CLI and
 * desktop. `wiringConfig`'s construction below still prefers the desktop
 * store's own `callCapturePersonalityId` when BOTH are set — desktop-specific
 * settings win over shared CLI config, same principle `auxiliaryAsr`/
 * `auxiliaryTts` already follow (see the field comments there).
 *
 * `readConfig` (not `readRawConfig`) so `${secrets:...}` refs are already
 * resolved to literal values — the voice-provider factories (`openaiSttFactory`
 * et al., in `@ethosagent/voice-providers`) read `apiKey` off the config
 * object as a literal, not a secret reference, exactly as
 * `apps/ethos/src/wiring.ts` relies on for the CLI's own `auxiliary.asr` /
 * `auxiliary.tts` wiring.
 *
 * Only these three fields are pulled from the shared file — every other
 * desktop-specific field (provider, model, personality, memory, …) stays
 * sourced from the Electron store, since those make sense to differ per
 * surface while STT/TTS credentials and the call-capture binding do not.
 *
 * Returns `{}` when `~/.ethos/config.yaml` doesn't exist or carries none of
 * `auxiliary.asr` / `auxiliary.tts` / `callCapture.personalityId` — matching
 * prior behavior for a machine that never ran `ethos setup`.
 */
export async function readSharedVoiceAndCallCaptureConfig(
  storage: Storage,
  secrets: SecretsResolver,
): Promise<Pick<WiringConfig, 'auxiliaryAsr' | 'auxiliaryTts' | 'callCapture'>> {
  const shared = await readConfig(storage, secrets);
  return {
    ...(shared?.auxiliary?.asr ? { auxiliaryAsr: shared.auxiliary.asr } : {}),
    ...(shared?.auxiliary?.tts ? { auxiliaryTts: shared.auxiliary.tts } : {}),
    ...(shared?.callCapture ? { callCapture: shared.callCapture } : {}),
  };
}

/**
 * The `learningReplay` option `createWebApi` takes — the on-demand replay
 * behind the `learning.replay` RPC (plan `trust-before-reach.md` L-D9). The same settings `ethos serve`
 * passes (`apps/ethos/src/commands/serve.ts`): two real dry-run loops built from
 * this backend's `wiringConfig`, graded by its default LLM, bounded by the
 * shared `~/.ethos/config.yaml`'s `learningReplay.*`. Built per replay, like
 * serve: it constructs an LLM provider, and a replay costs minutes anyway.
 *
 * `settings` null (the shared config could not be read) or `enabled: false` →
 * no option, and the inbox refuses `replay_unavailable`. An unreadable config
 * fails closed rather than spending money under settings nobody could check.
 */
export function desktopLearningReplay(opts: {
  settings: ReturnType<typeof resolveLearningReplay> | null;
  wiringConfig: WiringConfig;
  dataDir: string;
  personalities: Awaited<ReturnType<typeof createPersonalityRegistry>>;
}): Pick<Parameters<typeof createWebApi>[0], 'learningReplay'> {
  const { settings } = opts;
  if (!settings?.enabled) return {};
  return {
    learningReplay: async (candidateId: string) =>
      createLearningReplayer(opts.wiringConfig, {
        storage: new FsStorage(),
        dataDir: opts.dataDir,
        personalities: opts.personalities,
        expressions: opts.personalities,
        grader: await createLLM(opts.wiringConfig),
        settings,
        actor: 'web',
      })(candidateId),
  };
}

/**
 * The `readObservabilityEvents` option `createWebApi` takes — the MCP export
 * section's Recent denials (M-T9). `ethos mcp serve --personality` records its
 * `mcp.export.*` events into `observability.db`; `ethos serve` reads them from
 * its process-wide store (`apps/ethos/src/commands/serve.ts`), and the desktop
 * reads the same file under its data dir.
 *
 * Opened per read and closed again: the desktop records nothing into this
 * store, so a handle held open would only be one more resource for
 * `shutdownDesktopRuntime` to release. A missing file reads as no events,
 * because the store's constructor would otherwise CREATE an empty database on
 * a machine that never exported a personality.
 */
export function desktopReadObservabilityEvents(
  dataDir: string,
): NonNullable<Parameters<typeof createWebApi>[0]['readObservabilityEvents']> {
  const dbPath = join(dataDir, 'observability.db');
  return (filter) => {
    if (!existsSync(dbPath)) return [];
    const store = new SQLiteObservabilityStore(dbPath);
    try {
      return store.getEvents(filter);
    } finally {
      store.close();
    }
  };
}

export async function startServer(port: number): Promise<number> {
  if (runtime) return boundPort ?? port;
  // Filled in as each resource is created, so a start that fails half way
  // releases exactly what it built (F06) instead of stranding a loop whose
  // background executor keeps ticking with no server in front of it.
  const rt: DesktopRuntime = {};
  try {
    const actual = await bootRuntime(port, rt);
    runtime = rt;
    return actual;
  } catch (err) {
    boundPort = null;
    await shutdownDesktopRuntime(rt).catch((releaseErr: unknown) => {
      console.warn(
        `[ethos-backend] releasing a failed start also failed: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`,
      );
    });
    throw err;
  }
}

async function bootRuntime(port: number, rt: DesktopRuntime): Promise<number> {
  const dataDir = getDataDir();

  const provider = (store.get('provider') as string) ?? 'anthropic';
  const model = (store.get('model') as string) ?? 'claude-sonnet-4-20250514';
  const baseUrl = store.get('baseUrl') as string | undefined;

  // Prefer keychain; fall back to secrets file (written by the onboarding handler)
  const apiKey = (await getKeychainValue('api-key')) ?? '';

  // Same store the codex device-auth IPC handler writes to (see ipc.ts).
  // Without it the provider factories get the wiring package's null-object
  // fallback, so credentials that only live in the secret store — codex
  // OAuth tokens above all — read as absent at every LLM construction.
  const secretsResolver = new FileSecretsResolver({
    dir: join(dataDir, 'secrets'),
    storage: new FsStorage(),
  });

  // Shared STT/TTS infra and call-capture binding from the CLI's own
  // `~/.ethos/config.yaml` — see `readSharedVoiceAndCallCaptureConfig` above.
  // A parse/secret failure here must not take the whole backend down over an
  // unrelated field elsewhere in that file (e.g. a stale telegram token ref);
  // call capture just stays unavailable, exactly as it is today.
  let sharedVoiceAndCallCaptureConfig: Pick<
    WiringConfig,
    'auxiliaryAsr' | 'auxiliaryTts' | 'callCapture'
  > = {};
  try {
    sharedVoiceAndCallCaptureConfig = await readSharedVoiceAndCallCaptureConfig(
      new FsStorage(),
      secretsResolver,
    );
  } catch (err) {
    console.warn(
      '[ethos-backend] failed to read auxiliary.asr/auxiliary.tts/callCapture from ' +
        `~/.ethos/config.yaml — call capture will report itself unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Desktop's own `callCapturePersonalityId` store field wins when set — it
  // has no Settings UI yet, so today it's only ever set by hand-editing the
  // Electron store's JSON directly. Falls back to the shared config's
  // `callCapture.personalityId` (see `readSharedVoiceAndCallCaptureConfig`
  // above) so a fresh desktop install doesn't crash on startup when a
  // personality unconditionally ships the `call_capture` toolset capability.
  // `learningReplay.*` from the same shared file, so `learning.replay` runs
  // under the settings `ethos serve` reads (see `desktopLearningReplay`).
  let learningReplaySettings: ReturnType<typeof resolveLearningReplay> | null = null;
  try {
    learningReplaySettings = resolveLearningReplay(
      (await readConfig(new FsStorage(), secretsResolver)) ?? {},
    );
  } catch (err) {
    console.warn(
      '[ethos-backend] failed to read learningReplay from ~/.ethos/config.yaml — ' +
        `learning replay will report itself unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { callCapture: sharedCallCapture, ...sharedVoiceConfig } = sharedVoiceAndCallCaptureConfig;
  const callCapturePersonalityId = store.get('callCapturePersonalityId') as string | undefined;

  const wiringConfig: WiringConfig = {
    provider,
    model,
    apiKey,
    personality: (store.get('personalityId') as string | undefined) ?? 'operator',
    memory: store.get('memory') ?? 'markdown',
    ...(baseUrl ? { baseUrl } : {}),
    ...(callCapturePersonalityId
      ? { callCapture: { personalityId: callCapturePersonalityId } }
      : sharedCallCapture
        ? { callCapture: sharedCallCapture }
        : {}),
    ...sharedVoiceConfig,
    secretsResolver,
  };

  // Resolve the bundled built-in personalities directory up front — needed by
  // both `createAgentLoop()`'s own internal personality registry (via the
  // `builtinPersonalitiesDir` wiring option below) and the separate manual
  // registry constructed further down for desktop-specific personality
  // listing. `import.meta.dirname` inside `loadBuiltins()` points at the
  // bundled output dir after electron-vite, not the source tree, so it can't
  // find the real data dir unless we resolve it ourselves and pass it in.
  const builtinPersonalitiesDir = (() => {
    const candidates = [
      join(__dirname, '..', '..', 'extensions', 'personalities', 'data'),
      join(__dirname, '..', '..', '..', '..', 'extensions', 'personalities', 'data'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return undefined;
  })();

  // Same rationale, for call-capture's native binaries — resolved once here
  // so both `createAgentLoop()` (below, via `callCaptureNativeDir`) and
  // `startCallCaptureDesktop()` (further down) construct `TapCapture`/
  // `MicCapture`/`MicActivityDetector` against the real binary paths rather
  // than the bundled output dir. See `./call-capture`'s
  // `resolveCallCaptureNativeDir()` for the shared candidate-resolution logic.
  const callCaptureNativeDir = resolveCallCaptureNativeDir();

  const {
    loop,
    toolRegistry,
    sttProviders,
    ttsProviders,
    realtimeProviders,
    voiceConfig,
    voiceStack,
    refreshPersonalities,
    skillsInjector,
    executionBackends,
    onMemoryCaptured,
    runCallCapture,
    goals,
    memoryBundle,
    dispose: disposeLoop,
  } = await createAgentLoop(wiringConfig, {
    dataDir,
    profile: 'web',
    disableDocker: true,
    ...(builtinPersonalitiesDir ? { builtinPersonalitiesDir } : {}),
    ...(callCaptureNativeDir ? { callCaptureNativeDir } : {}),
  });
  rt.loop = { dispose: disposeLoop };

  const session = createSessionStore({ dataDir });
  rt.sessionStore = session;

  const personalities = await createPersonalityRegistry({
    storage: new FsStorage(),
    userPersonalitiesDir: dataDir,
  });

  // Load built-in personalities from the bundled data directory.
  if (builtinPersonalitiesDir) {
    await personalities.loadFromDirectory(builtinPersonalitiesDir);
  }

  await personalities.loadFromDirectory(join(dataDir, 'personalities'));

  const identityMap = new IdentityMap({ storage: new FsStorage(), dataDir });
  await identityMap.resolve('desktop', 'desktop', 'Desktop');

  const skillsCatalogDir = (() => {
    const candidates = [
      join(__dirname, '..', '..', 'skills'),
      join(__dirname, '..', '..', '..', '..', 'skills'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return undefined;
  })();

  const webDistDir = (() => {
    const candidates = [
      // Packaged app: extraResources lands under process.resourcesPath
      join(process.resourcesPath ?? '', 'web-dist'),
      // Dev: relative to bundled output
      join(__dirname, '..', '..', 'apps', 'web', 'dist'),
      join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'dist'),
    ];
    for (const c of candidates) {
      if (existsSync(join(c, 'index.html'))) return c;
    }
    return undefined;
  })();

  const {
    app: webApp,
    voiceSocket,
    satelliteSocket,
    takeoverSocket,
    forceSettleApprovals,
    closeChat,
    dispose: disposeWebApi,
  } = createWebApi({
    dataDir,
    sessionStore: session,
    // The memory surfaces `createAgentLoop` built from this same config (F04):
    // editor, Timeline, restore and approve on the backend the agent reads —
    // the vault under `memory: vault`, a refusal for `vector`.
    memoryBundle,
    identityMap,
    agentLoop: loop,
    // The goal store + loop-bearing executor `createAgentLoop` built together.
    // Without it a desktop goal was stored `running` and never executed.
    goals,
    // The screencast takeover lane's session registry (B3). The desktop is the
    // third in-process web-API host: `createAgentLoop` above built the browser
    // tools HERE, so the session `browser_request_takeover` locked is the one
    // this lookup reaches. Same seam `ethos serve`/`ethos boot` pass.
    browserTakeoverSessions: createBrowserTakeoverRegistry(),
    personalities,
    refreshPersonalities,
    // Renderer-capability seam for `personalities.renderers` (the loop's own
    // injector — one scanner, one mtime cache for the process).
    skillsInjector,
    // Settings › Execution — the probe reaches the loop's own backend instance
    // through this registry (`resolve()` memoises), so `Test connection` tests
    // the object remote commands run on. Same seam `ethos serve`/`ethos boot`
    // pass; the desktop is the third in-process web-API host.
    executionBackends,
    chatDefaults: { model, provider },
    // Threaded with the turn's personality (learned from the loop's
    // `session_start`) so `denyRules` and `approvalMode` are enforced, plus a
    // lazy provider handle for `approvalMode: 'smart'` — nothing is
    // constructed unless a flagged call actually reaches the reviewer.
    dangerPredicate: createApprovalDangerPredicate({
      hooks: [loop.hooks],
      personalities,
      getProvider: createLazyProvider(() => createLLM(wiringConfig)),
      model,
      alwaysAsk: APPROVAL_SURFACE_ALWAYS_ASK,
    }),
    ...(onMemoryCaptured ? { onMemoryCaptured } : {}),
    // `learning.replay` — absent, the desktop refused `REPLAY_UNAVAILABLE`
    // while `ethos serve` ran the replay.
    ...desktopLearningReplay({
      settings: learningReplaySettings,
      wiringConfig,
      dataDir,
      personalities,
    }),
    // M-T9 — the MCP export section's Recent denials, from the file
    // `ethos mcp serve --personality` records into.
    readObservabilityEvents: desktopReadObservabilityEvents(dataDir),
    // `mcpExportDesktopEntry` is deliberately NOT passed, so the section shows
    // no Claude Desktop entry here. The entry names the program Claude Desktop
    // launches: `ethos serve` builds it from its own `process.execPath` and CLI
    // script (`exportLauncher` + `claudeDesktopExportEntry`,
    // `apps/ethos/src/commands/mcp-export.ts`, not exported by `@ethosagent/cli`).
    // In this process those are the Electron binary and the desktop's main
    // bundle, neither of which has an `mcp serve` command, and the packaged app
    // ships no CLI script to name instead (`electron-builder.yml`). An entry
    // that launches the wrong program is worse than none.
    toolRegistry,
    // F1 — the desktop runs the in-process backend with Docker disabled, so the
    // character sheet must render the honest local (un-sandboxed) posture rather
    // than claiming Docker.
    dockerBuildable: false,
    sttProviderRegistry: sttProviders,
    sttProviderName: voiceConfig.sttProviderName,
    sttProviderConfig: voiceConfig.sttProviderConfig,
    ttsProviderRegistry: ttsProviders,
    ttsProviderName: voiceConfig.ttsProviderName,
    ttsProviderConfig: voiceConfig.ttsProviderConfig,
    // Named rosters — what a personality's `voice.tts_provider` /
    // `voice.stt_provider` pick from.
    ...(voiceConfig.ttsRoster ? { ttsRoster: voiceConfig.ttsRoster } : {}),
    ...(voiceConfig.sttRoster ? { sttRoster: voiceConfig.sttRoster } : {}),
    // Realtime tier — the registry backs `voice.realtimeToken`; the roster and
    // tier default are boot snapshots that live Settings config overrides.
    realtimeProviderRegistry: realtimeProviders,
    ...(voiceConfig.realtimeRoster ? { realtimeRoster: voiceConfig.realtimeRoster } : {}),
    ...(voiceConfig.realtimeDefault ? { realtimeDefault: voiceConfig.realtimeDefault } : {}),
    ...(voiceConfig.tier ? { voiceTier: voiceConfig.tier } : {}),
    // The typed per-call cap, and the span writer realtime turns record into —
    // both the same objects the `ethos serve` path passes.
    ...(voiceConfig.realtimeSessionBudgetUsd !== undefined
      ? { realtimeSessionBudgetUsd: voiceConfig.realtimeSessionBudgetUsd }
      : {}),
    ...(voiceStack ? { voiceSpans: voiceStack.spans } : {}),
    // Local-only voice-egress gate (`voice.trustedPlugins`); undefined = off.
    ...(voiceConfig.trustedVoicePlugins
      ? { trustedVoicePlugins: voiceConfig.trustedVoicePlugins }
      : {}),
    ...(skillsCatalogDir ? { catalogDir: skillsCatalogDir } : {}),
    ...(webDistDir ? { webDist: webDistDir } : {}),
  });
  rt.webApi = { dispose: disposeWebApi };
  rt.settleApprovals = forceSettleApprovals;
  rt.closeChat = closeChat;

  function bind(p: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const s = honoServe(
        { fetch: webApp.fetch, port: p, hostname: '127.0.0.1' },
        (info: AddressInfo) => {
          rt.server = s;
          // Talk-mode's streaming binary lane (`GET /voice/ws`). Unattached, the
          // route answers and never upgrades, so browser talk-mode silently
          // falls back to the batch RPC path — which is what the desktop has
          // been doing since the lane shipped.
          voiceSocket.attach(s);
          // The wake-satellite lane (`GET /satellite/ws`). Without this the
          // desktop would serve a satellite endpoint that never upgrades: the
          // route answers, the socket never opens, and the in-process host
          // across `satellite.ts` reconnects forever against its own backend.
          // Both lanes register through the SHARED upgrade router, so the order
          // of these two calls does not matter and neither can swallow the
          // other's upgrade. Same calls `ethos serve` makes; see
          // apps/ethos/src/commands/serve.ts.
          satelliteSocket.attach(s);
          // The browser-takeover screencast lane (`GET /browser/takeover/ws`),
          // on the same shared upgrade router. Unattached the route never
          // upgrades, so the takeover panel has nothing to connect to.
          takeoverSocket.attach(s);
          // Closed before the server: `server.close()` waits on open
          // connections, and a talk-mode tab or a satellite holds its lane
          // open indefinitely by design.
          rt.sockets = [voiceSocket, satelliteSocket, takeoverSocket];
          resolve(info.port);
        },
      );
      s.once('error', reject);
    });
  }

  let actual: number;
  try {
    actual = await bind(port);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EADDRINUSE') {
      actual = await bind(0);
    } else {
      throw err;
    }
  }

  boundPort = actual;
  console.log(`[ethos-backend] in-process server listening on http://127.0.0.1:${actual}`);
  const callCapture = startCallCaptureDesktop({
    wiringConfig,
    runCallCapture,
    dataDir,
    ...(callCaptureNativeDir ? { callCaptureNativeDir } : {}),
  });
  if (callCapture) rt.callCapture = callCapture;
  return actual;
}

export async function stopServer(): Promise<void> {
  const current = runtime;
  if (!current) return;
  runtime = null;
  boundPort = null;
  // Settle approvals first, then call capture, sockets and HTTP, then the web
  // API, the loop's runtime and the session store — `shutdownDesktopRuntime`
  // owns the order and attempts every step.
  await shutdownDesktopRuntime(current);
}

export function getPort(): number | null {
  return boundPort;
}
