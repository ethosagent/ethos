// `ethos listen` — the headless wake satellite, and `ethos listen doctor`, its
// preflight (voice V3, lane S5).
//
// ── THE TWO RULES THIS FILE EXISTS TO HOLD ───────────────────────────────────
//
// 1. NEVER PRETEND TO LISTEN. Every failure that would leave this daemon deaf —
//    a wake engine that will not load, a model file that never finished
//    downloading, a stdin with nothing piped into it — is reported before the
//    process settles into its keep-alive, and either degrades the host into a
//    state it announces out loud or refuses to start at all. A satellite that
//    prints "listening" and hears nothing is worse than one that exits: nobody
//    walks over to a machine that looks fine.
//
//    THE RULE OUTLIVES STARTUP. A preflight only covers the moment it ran, and
//    the loudest version of this failure happens a second later: the capture
//    command exits, its end of the pipe closes, and the banner keeps claiming a
//    microphone that is gone. So the device reports the end (`CaptureEnd` on the
//    `CaptureDevice` seam) and this daemon leaves non-zero — see
//    `onCaptureEnded`. stdin cannot be reopened; there is nothing to recover.
//
// 2. AVAILABILITY ONLY AFTER A REAL PROBE. The rows come from
//    `runSatelliteDoctor`, which asks the engine factory to load what it would
//    load and the device to enumerate what it would open. Nothing here reads a
//    config flag and calls it capability.
//
// ── WHAT THIS HOST CAN AND CANNOT DO ─────────────────────────────────────────
//
// CAPTURE IS A PIPE. `apps/ethos` has no audio binding and this lane does not
// add one: a native microphone module is a per-architecture binary, and this is
// the daemon that has to run on the Pi where such a binary is broken. So the
// operator supplies samples on stdin and the pipe is the device —
// `ffmpeg -nostats -loglevel error -f avfoundation -i :0 -ar 16000 -ac 1 -f s16le - | ethos listen`
// works today with nothing installed that is not installed already. See
// `../lib/stdin-pcm-device`.
//
// PLAYOUT IS A PIPE TOO, and for exactly the same reason. `--play` names a
// command this daemon spawns and writes the reply's audio into — the mirror
// image of the capture pipe, on the same argument: a speaker binding is the
// same per-architecture native module the microphone binding is. Absent the
// flag, the host probes `ffplay` / `aplay` / `play` on PATH and uses whichever
// it actually finds. NOT A CONFIG KEY, deliberately: which command drives THIS
// machine's sound card is a per-machine operator fact, exactly like the ffmpeg
// input pipe, and it belongs on the command line next to it rather than in a
// file a personality or a deployment could be tempted to carry around.
// `capabilities.playback` reports what was found and never what was hoped for;
// finding nothing degrades the turn to text, which is the rule that outranks
// every feature in this file.
//
// THE MIC IS OPEN, AND THE SERVER USUALLY DECIDES WHO WAS ADDRESSED. This host
// matches no phrase against SOUND: an acoustic keyword spotter is a
// per-architecture native binary, and this is the daemon that has to run on the
// Pi where such a binary is broken. So the daemon registers `phraseMatch: false`
// and the gate moves to where the transcript is. Speech detected on the pipe
// opens an utterance; every utterance is transcribed; and a turn runs only when
// the words open with a wake phrase from the effective route table, or when
// they follow one inside the addressing window. Everything else is heard,
// written down, and discarded without reaching a model.
//
// WHERE THE TRANSCRIBING HAPPENS IS THE PRIVACY FACT, and it has two answers.
// By default the SERVER transcribes, which means THE ROOM'S AUDIO LEAVES THIS
// MACHINE — not every utterance reaches an agent, but every utterance reaches
// the deployment's recognizer. With `voice.wake.edgeStt` on AND a recognizer
// whose `caps.local` is true, the recognizer runs HERE: the utterance is
// transcribed on this box and only the words go up. The daemon refuses to
// declare edge STT for a non-local recognizer, because "on-device" for a cloud
// transcriber is the same audio egress wearing a better word — see
// `resolveEdgeSttFrom`. Either way the room is transcribed; the doctor's
// `edge-stt` row says by whom.
//
// Acoustic wake (sherpa keyword spotting) belongs to the desktop host, which
// has the prebuilt binaries and a real microphone, and which therefore
// registers `phraseMatch: true` and is not gated server-side. `listen doctor`
// still probes sherpa honestly when it is configured — those rows feed the
// Settings → Voice row for every host, not just this one.
//
// THE ROUTE TABLE BELONGS TO THE SERVER. `voice.wake.routes` in this machine's
// config is a HINT, not the answer: the web-api synthesizes a bare-NAME route
// (`auto:<personalityId>`) for every UNPRIVILEGED personality and pushes
// the merged table down the lane immediately after `register`. This daemon
// never picks a personality — the phrase does — so `--route` is optional and
// means something narrower than it used to: a PIN, restricting which single
// route this microphone may be addressed by. `listen doctor`, which never
// connects, reports the local table as a hint and says out loud that the
// effective one is only knowable once connected.

import { join } from 'node:path';
import { ethosDir, loadConfigStrict } from '@ethosagent/config';
import { resolveSttProvider } from '@ethosagent/core';
import {
  EthosError,
  type SecretsResolver,
  type Storage,
  type SttProvider,
  type SttProviderEntry,
  type SttProviderRegistry,
} from '@ethosagent/types';
import {
  type AudioDeviceInfo,
  type CaptureDevice,
  type CaptureEnd,
  CaptureMachine,
  type CaptureState,
  createEnergyFrameVad,
  createSatelliteClient,
  createSherpaWakeEngineFactory,
  encodeUtteranceWav,
  type PlaybackDevice,
  runSatelliteDoctor,
  SatellitePlayout,
  transcriptWakeEngineFactory,
  type WakeEngine,
  type WakeEngineFactory,
  type WakeFrame,
  type WakeRoute,
  wakePhraseKey,
} from '@ethosagent/voice-satellite';
import { createStdinPcmDevice, STDIN_DEVICE_ID } from '../lib/stdin-pcm-device';
import { emitReady } from '../logger';
import { notifyReady, startWatchdog } from '../sd-notify';
import { getSecretsResolver, getStorage } from '../wiring';
import { WARN_EXIT } from './_shared';
import {
  authCookie,
  type ListenDaemonContext,
  type ListenHeartbeat,
  protocolState,
} from './listen-daemon';
import {
  AUDIO_GOES_UP,
  capabilityRows,
  EDGE_STT_OFF,
  EDGE_UTTERANCE_MAX_BYTES,
  type EdgeSttResolution,
  edgeSttReport,
} from './listen-edge-stt';
import { createCommandPlaybackDevice, resolvePlayer } from './listen-player';
import {
  computeListenExit,
  deriveListenFailFlags,
  deriveListenUrls,
  isFatalRow,
  LANE_PROBE_NAME,
  type ListenPreflight,
  type ListenStartOptions,
  type ListenUrls,
  resolveListenNodeId,
  withLaneProbeName,
  withPipeCaveat,
} from './listen-preflight';
import { probeSatelliteLane } from './listen-probes';
import {
  EMPTY_TABLE_WARNING,
  readSatelliteVadTuning,
  readWakeRoutes,
  resolveRoutePin,
} from './listen-routes';

export type { ListenHeartbeat } from './listen-daemon';

export {
  capabilityRows,
  type EdgeSttReport,
  type EdgeSttResolution,
  edgeSttReport,
} from './listen-edge-stt';
export {
  type CommandPlaybackDeviceOptions,
  createCommandPlaybackDevice,
  type PlayerKind,
  type PlayerProcess,
  type PlayerReport,
  type PlayerResolution,
  playerArgv,
  resolvePlayer,
} from './listen-player';
export {
  computeListenExit,
  deriveListenFailFlags,
  deriveListenUrls,
  LANE_PROBE_NAME,
  type ListenFailFlags,
  type ListenPreflight,
  type ListenStartOptions,
  type ListenUrls,
  resolveListenNodeId,
  withLaneProbeName,
  withPipeCaveat,
} from './listen-preflight';
export { probeHealthz, probeSatelliteLane, type SatelliteLaneProbe } from './listen-probes';
export { EMPTY_TABLE_WARNING, readSatelliteVadTuning, resolveRoutePin } from './listen-routes';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

export const USAGE = `Usage: ethos listen [doctor] [options]

  (no subcommand)   run the wake satellite in the foreground
  doctor            preflight: engine, model files, capture device, satellite lane

Options:
  --url <ws url>    satellite lane URL (default: derived from webBaseUrl)
  --route <id>      PIN this microphone to one route: only that phrase may
                    address it. Checked against the table the server pushes on
                    connect — a voice.wake.routes id or a synthesized
                    'auto:<personalityId>' one. Optional; without it every
                    phrase in the table can address this host
  --device <id>     capture device (this build ships '${STDIN_DEVICE_ID}' only)
  --play <command>  command to play the reply through. Audio is written to its
                    stdin; {rate} and {channels} are substituted. Without it
                    this host probes ffplay, then aplay, then play on PATH —
                    and answers as TEXT ONLY if it finds none
  --json            doctor only — one JSON object with a probes array and exit

Capture is a pipe. This daemon reads raw signed-16-bit little-endian MONO PCM
from stdin, so a microphone is whatever can write that:

  ffmpeg -nostats -loglevel error -f avfoundation -i :0 -ar 16000 -ac 1 -f s16le - | ethos listen
  arecord -q -f S16_LE -r 16000 -c 1 -t raw                                        | ethos listen

Keep the quiet flags. The capture process and this daemon share one terminal,
and ffmpeg's progress meter is a carriage-returned line that overwrites this
daemon's output mid-word. A real failure still prints.

Open mic, server-side addressing. Nothing is acoustically wake-matched here:
EVERY utterance on the pipe is transcribed. It reaches an agent only when the
words open with a personality's name — that name picks the personality, and a
greeting in front of it is optional — or when they follow one within
voice.wake.idleTimeout. Anything else is heard and discarded.

Who transcribes decides whether the audio leaves this machine. By default the
server does. Set voice.wake.edgeStt: true with a LOCAL speech-to-text provider
(auxiliary.asr → local-stt / command-stt) and the recognizer runs here instead:
only the words go up. A non-local provider is refused rather than relabelled;
ethos listen doctor names which recognizer resolved, and why.

Closing the pipe stops the satellite. stdin cannot be reopened, so a capture
command that exits — a bad device index, a denied permission, an ordinary end
of stream — ends this process non-zero rather than leaving it looking alive.`;

/**
 * Rate the wake engines, the VAD, and the server-side recognizers all assume.
 * Fixed rather than configurable: raw PCM carries no header, so a mismatch
 * between what the operator piped and what we declare is undetectable, and the
 * only defence is one number printed in the help text next to the ffmpeg flags.
 */
const CAPTURE_SAMPLE_RATE = 16_000;

/** Frame length. 20ms is `EnergyVad`'s unit and the wake seam's. */
const CAPTURE_FRAME_MS = 20;

/** Same cadence as the gateway heartbeat — the readers are the same readers. */
const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * How the daemon leaves when its capture pipe closes under it.
 *
 * The SAME code as "nothing is piped to stdin — not starting", because it is
 * the same condition found a few seconds later, and a satellite that cannot
 * hear has failed whichever moment it discovers that in. Non-zero is the
 * load-bearing part: a supervisor restarting `ffmpeg | ethos listen` on failure
 * is exactly the right response, and exit 0 would tell it the work is done.
 */
const CAPTURE_ENDED_EXIT = 1;

/**
 * How to enumerate input devices on this host, named when a pipe closed before
 * it ever carried a frame — the case where the capture command's own arguments
 * are the overwhelmingly likely fault.
 */
function listDevicesHint(): string {
  return process.platform === 'darwin'
    ? 'ffmpeg -f avfoundation -list_devices true -i ""'
    : 'arecord -l';
}

/**
 * Fallback for the addressing window in the banner, matching the server's own
 * `WAKE_SETTINGS_DEFAULTS.idleTimeoutMs`. Only ever printed before the first
 * `routes` frame lands — after that the SERVER's number is used, because the
 * server is the one enforcing it.
 */
const DEFAULT_IDLE_WINDOW_MS = 30_000;

/**
 * The one sentence every surface that talks about routes without a connection
 * has to say. Written once so the doctor row, the `--json` object, and the
 * daemon's banner cannot drift into three different claims.
 */
const ROUTES_ARE_THE_SERVERS =
  "The effective table is the server's: it adds a bare-NAME route " +
  '(auto:<personalityId>) for every unprivileged personality, pushes the merged ' +
  'table on connect, and MATCHES transcripts against it — so what this host can ' +
  'be addressed by is only knowable once it has connected.';

/** Where wake / edge-STT models are expected, per the satellite doctor's own tests. */
function wakeModelDir(): string {
  return join(ethosDir(), 'models', 'wake');
}

/** Composed once, then persisted verbatim. See `resolveListenNodeId`. */
function listenNodeIdPath(): string {
  return join(ethosDir(), 'listen-node-id');
}

/** Same contract and cadence as `gateway-health.json`; see `buildListenHeartbeat`. */
function listenHealthPath(): string {
  return join(ethosDir(), 'listen-health.json');
}

/**
 * Conventional sherpa transducer file names inside `wakeModelDir()`.
 *
 * Not configurable, deliberately: a per-file path knob is four more ways for a
 * model download to be half-configured, and the failure it would enable —
 * "three of the four files resolved" — is exactly the class this preflight is
 * here to catch. Rename the files or symlink them.
 */
const SHERPA_MODEL_FILES = {
  encoder: 'encoder.onnx',
  decoder: 'decoder.onnx',
  joiner: 'joiner.onnx',
  tokens: 'tokens.txt',
};

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export interface ListenFlags {
  json: boolean;
  url?: string;
  route?: string;
  device?: string;
  /** `--play` — the command the reply's audio is written into. See `resolvePlayer`. */
  play?: string;
  positional: string[];
}

export function parseListenFlags(args: string[]): ListenFlags {
  const flags: ListenFlags = { json: false, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') flags.json = true;
    else if (a === '--url') flags.url = args[++i];
    else if (a === '--route') flags.route = args[++i];
    else if (a === '--device') flags.device = args[++i];
    else if (a === '--play') flags.play = args[++i];
    else if (a !== undefined) flags.positional.push(a);
  }
  return flags;
}

/**
 * Resolve the on-device recognizer from an already-built registry.
 *
 * ONE RESOLUTION PATH. It is `resolveSttProvider` from `@ethosagent/core` —
 * the same function the gateway, the web-api and the voice stack call — so the
 * `trustedVoicePlugins` egress gate inside it applies to a satellite exactly as
 * it applies to everything else, and the id this row prints is the id that
 * actually ran. A second resolution here would be a second place for the gate
 * to have a hole.
 *
 * AND THE LINE THIS FUNCTION EXISTS TO HOLD: a recognizer whose `caps.local`
 * is not true is REFUSED, however the operator configured it. "Edge STT" backed
 * by a cloud transcriber still uploads the room; declaring `edgeStt: true` for
 * it would make the server stop sending audio while the audio went anyway, and
 * the one privacy claim this whole lane makes would be false in exactly the
 * deployment that asked for it. The fallback is gateway-side STT — which works,
 * and is honest about what it does.
 */
export async function resolveEdgeSttFrom(
  registry: SttProviderRegistry,
  input: {
    /** `auxiliary.asr` — provider name plus its factory config. */
    asr: SttProviderEntry | undefined;
    /** `voice.trustedPlugins`, as the gate wants it. */
    trustedVoicePlugins?: ReadonlySet<string>;
    secrets?: SecretsResolver;
  },
): Promise<EdgeSttResolution> {
  const resolution = await resolveSttProvider({
    registry,
    providerName: input.asr?.provider,
    providerConfig: { ...input.asr },
    ...(input.secrets ? { secrets: input.secrets } : {}),
    ...(input.trustedVoicePlugins ? { trustedVoicePlugins: input.trustedVoicePlugins } : {}),
  });
  if (!resolution.ok) {
    return {
      provider: null,
      ...(resolution.providerId === undefined ? {} : { providerId: resolution.providerId }),
      reason:
        resolution.code === 'not_configured'
          ? `voice.wake.edgeStt is on, but no speech-to-text provider is configured ` +
            `(auxiliary.asr.provider) — there is nothing to run on this machine, so ${AUDIO_GOES_UP}`
          : `voice.wake.edgeStt is on, but ${resolution.error}. Falling back: ${AUDIO_GOES_UP}`,
    };
  }
  if (resolution.provider.caps.local !== true) {
    return {
      provider: null,
      providerId: resolution.providerId,
      reason:
        `voice.wake.edgeStt is on, but the recognizer it resolved — "${resolution.providerId}" — ` +
        'is not local (caps.local is not true). Running it "at the edge" would upload this ' +
        'room anyway, so edge STT is REFUSED rather than relabelled, and ' +
        `${AUDIO_GOES_UP} Configure a local recognizer (auxiliary.asr.provider: local-stt or ` +
        'command-stt) to keep the audio here.',
    };
  }
  return { provider: resolution.provider, providerId: resolution.providerId };
}

/**
 * The production resolver: gate on the config flag, then build the registry.
 *
 * The registry import is LAZY and only happens when edge STT was actually
 * asked for — `@ethosagent/wiring` drags in the whole provider graph, and
 * `listen doctor` on a host that wants none of it should not pay for it.
 */
async function resolveEdgeStt(input: {
  requested: boolean;
  asr: SttProviderEntry | undefined;
  trustedVoicePlugins?: ReadonlySet<string>;
  secrets?: SecretsResolver;
}): Promise<EdgeSttResolution> {
  if (!input.requested) return { provider: null, reason: EDGE_STT_OFF };
  let registry: SttProviderRegistry;
  try {
    const { createBuiltinVoiceRegistries } = await import('@ethosagent/wiring');
    registry = createBuiltinVoiceRegistries().sttProviders;
  } catch (err) {
    return {
      provider: null,
      reason:
        `voice.wake.edgeStt is on, but the voice provider registry would not load: ` +
        `${err instanceof Error ? err.message : String(err)}. Falling back: ${AUDIO_GOES_UP}`,
    };
  }
  return resolveEdgeSttFrom(registry, {
    asr: input.asr,
    ...(input.trustedVoicePlugins ? { trustedVoicePlugins: input.trustedVoicePlugins } : {}),
    ...(input.secrets ? { secrets: input.secrets } : {}),
  });
}

/** The seam that makes the sub-router drivable without booting anything. */
export interface ListenCommandDeps {
  /** Runs every probe and resolves the context they describe. Never throws. */
  preflight(flags: ListenFlags): Promise<ListenPreflight>;
  /** Boots the daemon. Returns only on shutdown. */
  start(preflight: ListenPreflight, flags: ListenFlags): Promise<void>;
}

// ---------------------------------------------------------------------------
// Entry point — builds real deps, then delegates to the testable core
// ---------------------------------------------------------------------------

export async function runListen(args: string[], opts: ListenStartOptions = {}): Promise<void> {
  await runListenCommand(args, buildRealDeps(opts));
}

function buildRealDeps(opts: ListenStartOptions): ListenCommandDeps {
  const storage = getStorage();
  const device = createStdinPcmDevice({
    stdin: process.stdin,
    sampleRate: CAPTURE_SAMPLE_RATE,
    frameMs: CAPTURE_FRAME_MS,
  });
  /**
   * The recognizer the PREFLIGHT constructed, handed to the daemon unchanged.
   *
   * Resolving twice would let the doctor row describe one provider and the
   * daemon run another — the exact "reads a flag and calls it capability"
   * failure the preflight exists to refuse, one indirection out. So the probe
   * IS the construction, and this box carries its result across.
   */
  const probed: { edge: EdgeSttResolution | null } = { edge: null };
  return {
    preflight: (flags) => realPreflight(flags, storage, device, probed),
    start: (pre, flags) =>
      startListenDaemon(pre, flags, {
        storage,
        device,
        ...(probed.edge?.provider ? { edgeSttProvider: probed.edge.provider } : {}),
        ...opts,
      }),
  };
}

// ---------------------------------------------------------------------------
// Sub-router
// ---------------------------------------------------------------------------

export async function runListenCommand(args: string[], deps: ListenCommandDeps): Promise<void> {
  const flags = parseListenFlags(args);
  switch (flags.positional[0] ?? '') {
    case '':
      return listenDaemonCommand(flags, deps);
    case 'doctor':
      return listenDoctorCommand(flags, deps);
    default:
      console.log(USAGE);
      process.exitCode = 1;
      return;
  }
}

// ---------------------------------------------------------------------------
// `ethos listen doctor`
// ---------------------------------------------------------------------------

async function listenDoctorCommand(flags: ListenFlags, deps: ListenCommandDeps): Promise<void> {
  const pre = await deps.preflight(flags);
  const exit = computeListenExit(deriveListenFailFlags(pre));

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify({
        nodeId: pre.nodeId,
        url: pre.url,
        healthUrl: pre.healthUrl,
        engine: {
          configured: pre.configuredEngine,
          modelsRequired: pre.modelsRequired,
          // The daemon does not acoustically match; a consumer reading this
          // must not infer wake capability from the engine name alone. The
          // room IS transcribed — the phrase gate runs on the server.
          daemonMode: 'open-mic',
          phraseMatch: false,
        },
        captureDevice: pre.device,
        sampleRate: pre.sampleRate,
        // Deliberately NOT a resolved `route`: this command never connects, and
        // the effective table is the server's. A consumer that needs to know
        // what the house answers to must ask the server, not this object.
        configuredRoutes: pre.routes,
        /** The `--route` PIN, unvalidated. Null means every phrase may address. */
        requestedRoute: pre.requestedRoute ?? null,
        routesNote: ROUTES_ARE_THE_SERVERS,
        // Kept as a top-level boolean because scripts already branch on it,
        // and it means what it always meant: the operator ASKED. `edgeStt`
        // beside it is what they got.
        edgeSttRequested: pre.edgeStt.requested,
        edgeStt: {
          requested: pre.edgeStt.requested,
          enabled: pre.edgeStt.enabled,
          provider: pre.edgeStt.providerId ?? null,
          detail: pre.edgeStt.detail,
        },
        playback: {
          available: pre.player.player !== null,
          kind: pre.player.player?.kind ?? null,
          command: pre.player.player?.command ?? null,
          detail: pre.player.detail,
        },
        probes: pre.probes.map((p) => ({
          name: p.name,
          ok: p.ok,
          ...(p.detail === undefined ? {} : { detail: p.detail }),
          // The prose says why in English; `code` says the same thing in a form
          // a CI check can branch on without matching on a sentence.
          ...(p.name === LANE_PROBE_NAME && pre.laneFailureCode !== undefined
            ? { code: pre.laneFailureCode }
            : {}),
        })),
        errors: pre.errors,
        exit,
      })}\n`,
    );
    if (exit > 0) process.exitCode = exit;
    return;
  }

  console.log('');
  console.log(`${c.bold}ethos listen doctor${c.reset}  ${c.dim}wake satellite preflight${c.reset}`);
  console.log('');
  printPreflightRows(pre);
  console.log('');
  if (exit === 0) {
    console.log(
      `${c.green}✓ Preflight clean.${c.reset} Start with ${c.bold}ethos listen${c.reset}.`,
    );
  } else if (exit === WARN_EXIT) {
    console.log(
      `${c.yellow}⚠ Nothing is broken on this host, but it cannot listen right now.${c.reset}`,
    );
  } else {
    console.log(
      `${c.red}✗ This host cannot run a wake satellite until the ✗ rows above are fixed.${c.reset}`,
    );
  }
  if (exit > 0) process.exitCode = exit;
}

/**
 * Where a line goes. Under `--json` stdout belongs to the doctor's one object
 * and nothing else, so every human-readable line moves to stderr.
 */
function writerFor(flags: ListenFlags): (line: string) => void {
  return flags.json ? (line: string) => console.error(line) : (line: string) => console.log(line);
}

function printPreflightRows(pre: ListenPreflight, say: (line: string) => void = console.log): void {
  const printRow = (label: string, glyph: string, detail?: string): void => {
    say(`  ${glyph}  ${label.padEnd(22)} ${detail ? `${c.dim}${detail}${c.reset}` : ''}`.trimEnd());
  };
  for (const note of pre.deprecations) {
    printRow('deprecation', `${c.yellow}⚠${c.reset}`, note);
  }
  for (const err of pre.errors) {
    printRow('setup', `${c.red}✗${c.reset}`, err);
  }
  for (const row of pre.probes) {
    const glyph =
      row.skipped === true
        ? `${c.dim}–${c.reset}`
        : row.ok
          ? `${c.green}✓${c.reset}`
          : isFatalRow(row, pre)
            ? `${c.red}✗${c.reset}`
            : `${c.yellow}⚠${c.reset}`;
    // A models row on a host that runs no acoustic engine is information, not a
    // fault: say which engine made it irrelevant rather than printing a red ✗
    // about files nothing on this machine will open.
    const detail =
      row.name === 'models' && !row.ok && !pre.modelsRequired
        ? `not required by the '${pre.configuredEngine}' engine — ${row.detail ?? ''}`
        : row.detail;
    printRow(row.name, glyph, detail);
  }
  printRow('node id', `${c.green}✓${c.reset}`, `${pre.nodeId} (${listenNodeIdPath()})`);
  // Labelled `satellite url`, not `server`: reachability is the `satellite-lane`
  // row above, and a ✓ next to "server" would read as "it answered" when all
  // this row means is "this is the address it would dial".
  printRow('satellite url', `${c.green}✓${c.reset}`, pre.url);
  // NOT a ✓ or a ⚠ — a dash. This command never connects, so it has no verdict
  // to give about routing: it reports what THIS file contributes and names the
  // authority for the rest.
  printRow(
    'route',
    `${c.dim}–${c.reset}`,
    (pre.routes.length > 0
      ? `configured here: ${pre.routes.map((r) => `${r.id} ("${r.phrase}" → ${r.personalityId})`).join(', ')}. `
      : 'none configured here, which is normal. ') +
      ROUTES_ARE_THE_SERVERS +
      (pre.requestedRoute === undefined
        ? ' Without --route, every phrase in that table can address this host.'
        : ` --route ${pre.requestedRoute} pins this host to that one route; it is checked against the pushed table when \`ethos listen\` connects, not here.`),
  );
}

// ---------------------------------------------------------------------------
// `ethos listen`
// ---------------------------------------------------------------------------

async function listenDaemonCommand(flags: ListenFlags, deps: ListenCommandDeps): Promise<void> {
  const say = writerFor(flags);
  say(`${c.bold}ethos listen${c.reset}  ${c.dim}starting...${c.reset}`);
  say(
    `${c.dim}Runs in the foreground. Capture is a pipe: ${c.reset}` +
      `${c.bold}ffmpeg -nostats -loglevel error -f avfoundation -i :0 -ar ${CAPTURE_SAMPLE_RATE} -ac 1 -f s16le - | ethos listen${c.reset}`,
  );

  // Preflight FIRST, always. Refusing to start deaf is only possible if we
  // looked before we started.
  const pre = await deps.preflight(flags);
  const fail = deriveListenFailFlags(pre);
  printPreflightRows(pre, say);

  if (fail.setupError) {
    console.error(`${c.red}✗ Cannot start — fix the setup rows above.${c.reset}`);
    process.exitCode = 1;
    return;
  }
  if (!pre.transcriptEngineOk) {
    // (b) No usable engine remains. There is nothing to degrade to.
    console.error(
      `${c.red}✗ No usable wake engine on this host — not starting.${c.reset} ` +
        'Every engine probe failed; see the rows above.',
    );
    process.exitCode = 1;
    return;
  }
  if (fail.engineFailed || fail.modelsMissing) {
    // (a) A usable engine remains — continue, loudly. The configured acoustic
    // engine is a desktop-host concern anyway; say which one failed and why so
    // the operator is not left inferring it from silence.
    for (const row of pre.probes) {
      if (row.ok || row.skipped === true) continue;
      if (!row.name.startsWith('engine:') && row.name !== 'models') continue;
      say(`${c.yellow}⚠ degraded${c.reset} ${c.dim}${row.name}: ${row.detail}${c.reset}`);
    }
  }
  if (pre.device === null) {
    console.error(
      `${c.red}✗ Nothing is piped to stdin — not starting.${c.reset}\n` +
        `  This daemon captures raw s16le mono PCM at ${CAPTURE_SAMPLE_RATE} Hz from a pipe:\n` +
        `    ${c.bold}ffmpeg -nostats -loglevel error -f avfoundation -i :0 -ar ${CAPTURE_SAMPLE_RATE} -ac 1 -f s16le - | ethos listen${c.reset}\n` +
        `    ${c.bold}arecord -q -f S16_LE -r ${CAPTURE_SAMPLE_RATE} -c 1 -t raw | ethos listen${c.reset}`,
    );
    process.exitCode = 1;
    return;
  }
  // No route gate here. The table this daemon routes against is the server's,
  // and it arrives on the socket — see `startListenDaemon`, which refuses AFTER
  // the push rather than guessing from the local file before it.
  if (fail.serverUnreachable) {
    say(
      `${c.yellow}⚠ ${LANE_PROBE_NAME}${c.reset} ${c.dim}${pre.url} is not answering yet — ` +
        `the satellite will keep retrying with backoff, and will wait for its route ` +
        `table before it captures anything.${c.reset}`,
    );
  }

  await deps.start(pre, flags);
}

// ---------------------------------------------------------------------------
// Preflight — the real one
// ---------------------------------------------------------------------------

/**
 * An engine the config names and this build does not implement.
 *
 * Falling through to the transcript engine silently would be the false-available
 * failure with the sign flipped: the operator asked for openWakeWord and got
 * something else without being told.
 */
function unimplementedEngineFactory(name: string): WakeEngineFactory {
  return {
    name,
    async probe() {
      return {
        ok: false,
        engine: name,
        detail:
          `voice.wake.engine is '${name}', and no '${name}' engine ships in this build. ` +
          `Use 'sherpa' (optional native peer) or 'fallback' (the transcript engine).`,
      };
    },
    create() {
      // Unreachable today — the doctor only probes, and the daemon runs the
      // open-mic engine — but it refuses rather than quietly handing back some
      // other engine, which is the same false-available failure wearing the
      // opposite sign.
      return {
        name,
        async init(): Promise<void> {
          throw new EthosError({
            code: 'CONFIG_INVALID',
            cause: `No '${name}' wake engine ships in this build.`,
            action: `Set voice.wake.engine to 'sherpa' or 'fallback' in ~/.ethos/config.yaml.`,
          });
        },
        push: () => null,
        reset(): void {},
        async dispose(): Promise<void> {},
      };
    },
  };
}

async function realPreflight(
  flags: ListenFlags,
  storage: Storage,
  device: CaptureDevice,
  probed: { edge: EdgeSttResolution | null },
): Promise<ListenPreflight> {
  const errors: string[] = [];

  const secrets = await getSecretsResolver();
  let config: Awaited<ReturnType<typeof loadConfigStrict>> = null;
  try {
    config = await loadConfigStrict(storage, secrets);
  } catch (err) {
    errors.push(`config could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (config === null && errors.length === 0) {
    errors.push('no ~/.ethos/config.yaml — run `ethos setup` first');
  }
  for (const parseError of config?.parseErrors ?? []) errors.push(`config: ${parseError}`);

  const wake = config?.config.voice?.wake;
  // `fallback` is the config's name for the engine that calls itself
  // `transcript`; the probe rows are keyed on the engine's own name, so the
  // translation happens once, here.
  const configuredEngine =
    wake?.engine === undefined || wake.engine === 'fallback' ? 'transcript' : wake.engine;

  let urls: ListenUrls = { socket: '', health: '' };
  try {
    urls = deriveListenUrls(config?.config.webBaseUrl, flags.url);
  } catch {
    errors.push(`could not parse the server URL: ${flags.url ?? config?.config.webBaseUrl}`);
  }

  const modelDir = wakeModelDir();
  const engineFactories: WakeEngineFactory[] = [transcriptWakeEngineFactory];
  if (configuredEngine === 'sherpa') {
    engineFactories.push(
      createSherpaWakeEngineFactory({ storage, modelDir, files: SHERPA_MODEL_FILES }),
    );
  } else if (configuredEngine !== 'transcript') {
    engineFactories.push(unimplementedEngineFactory(configuredEngine));
  }

  // The shared doctor's `gatewayProbe` seam hands back `{ok, detail}` and
  // nothing else, so the errno is caught here on the way past rather than
  // squeezed into the prose and re-parsed out of it downstream.
  let laneFailureCode: string | undefined;
  const doctor = await runSatelliteDoctor({
    engineFactories,
    storage,
    modelDir,
    audioDevice: device,
    ...(urls.health
      ? {
          gatewayProbe: async () => {
            const lane = await probeSatelliteLane(urls.socket, urls.health);
            laneFailureCode = lane.code;
            return lane;
          },
        }
      : {}),
  });

  const devices = await device.list().catch((): AudioDeviceInfo[] => []);
  let selected: AudioDeviceInfo | null = devices.find((d) => d.isDefault) ?? devices[0] ?? null;
  if (flags.device !== undefined) {
    const named = devices.find((d) => d.id === flags.device) ?? null;
    if (named === null) {
      errors.push(
        `unknown --device ${flags.device}; this build enumerates: ` +
          (devices.length > 0 ? devices.map((d) => d.id).join(', ') : '(none)'),
      );
    }
    selected = named;
  }

  const routes = readWakeRoutes(wake?.routes);

  // BOTH OF THESE ARE PROBES, not config reads — which is why they run here
  // beside the engine and device probes rather than being inferred later. The
  // player probe asks PATH what is installed; the recognizer probe CONSTRUCTS
  // the provider (through the one resolution path, so the egress gate applies)
  // and reads its real `caps.local`. A row that reported either from a config
  // key would be the false-available failure this command exists to refuse.
  const player = resolvePlayer(flags.play);
  const trustedPlugins = config?.config.voice?.trustedPlugins;
  const edge = await resolveEdgeStt({
    requested: wake?.edgeStt === true,
    asr: config?.config.auxiliary?.asr,
    ...(trustedPlugins ? { trustedVoicePlugins: new Set(trustedPlugins) } : {}),
    secrets,
  });
  probed.edge = edge;
  const edgeStt = edgeSttReport(wake?.edgeStt === true, edge);
  const vadTuning = readSatelliteVadTuning(config?.config.voice?.bargeIn?.satellite);

  return {
    // Renamed exactly here, once, so the row, the fail flags and the JSON
    // cannot disagree about what the reachability probe is called; and the
    // pipe caveat applied in the same place, for the same reason.
    probes: [
      ...withPipeCaveat(withLaneProbeName(doctor.probes)),
      ...capabilityRows(player, edgeStt),
    ],
    configuredEngine,
    transcriptEngineOk: doctor.probes.some((p) => p.name === 'engine:transcript' && p.ok),
    modelsRequired: configuredEngine === 'sherpa',
    url: urls.socket,
    healthUrl: urls.health,
    ...(laneFailureCode === undefined ? {} : { laneFailureCode }),
    nodeId: await resolveListenNodeId(storage, listenNodeIdPath()),
    routes,
    ...(flags.route === undefined ? {} : { requestedRoute: flags.route }),
    edgeStt,
    player,
    device: selected,
    sampleRate: CAPTURE_SAMPLE_RATE,
    ...(wake?.idleTimeout === undefined ? {} : { idleTimeoutMs: wake.idleTimeout * 1000 }),
    ...(vadTuning === undefined ? {} : { vadTuning }),
    errors,
    deprecations: config?.deprecations ?? [],
  };
}

/**
 * One entry in the `Addressable here` line.
 *
 * A default route's phrase IS the personality's name, so printing
 * `"researcher" → researcher` says the same word twice and teaches nothing. The
 * arrow earns its place only when the phrase and the personality differ — a
 * custom route, where knowing who answers is the whole point. What is left is a
 * list of things to SAY, which is what somebody standing in front of the
 * microphone actually needs.
 *
 * Compared on `wakePhraseKey` so a route written `hey researcher` counts as the
 * name too: that phrase and the bare name are one trigger to the matcher, and a
 * banner that drew an arrow for one and not the other would be describing a
 * distinction the room does not have.
 */
export function addressableEntry(route: WakeRoute): string {
  const bare = wakePhraseKey(route.phrase) === route.personalityId.toLowerCase();
  return (
    `${c.bold}"${route.phrase}"${c.reset}` +
    (bare ? '' : `${c.dim} →${c.reset} ${c.cyan}${route.personalityId}${c.reset}`)
  );
}

// ---------------------------------------------------------------------------
// The daemon
// ---------------------------------------------------------------------------

/**
 * The OPEN-MIC engine: it opens an utterance on speech, and matches nothing.
 *
 * NOT "push-to-talk", which is what this was called and was never true — there
 * is no button, and there never was. The pipe carries whatever the room says;
 * a VAD decides where one utterance stops and the next begins; and who was
 * addressed is settled downstream, by the server, from the transcript. Calling
 * it push-to-talk implied a human hand in the loop that does not exist, on the
 * exact host most likely to be left running unattended in a room.
 *
 * It sits behind the same `WakeEngine` seam an acoustic spotter would, so the
 * whole of `CaptureMachine` — the watchdog, the verified re-arm, the self-wake
 * suppression — applies unchanged. It reports no route and no phrase, because
 * it matched neither: this host registers `phraseMatch: false` and the wire
 * contract makes both fields optional for exactly that reason.
 */
function createOpenMicEngine(vadTuning: ListenPreflight['vadTuning']): WakeEngine {
  let vad = createEnergyFrameVad(vadTuning);
  return {
    name: 'open-mic',
    async init(): Promise<void> {},
    push(frame) {
      if (!vad.push(frame)) return null;
      // No score to report: a VAD found energy, not a phrase. `confidence` is
      // documented as the engine's own scale, so certainty that SPEECH started
      // is the true value rather than a number invented to look like a
      // phrase-match probability.
      return { confidence: 1 };
    },
    reset(): void {
      // A fresh detector rather than a flag: `EnergyVad` carries hangover
      // frames, and a re-arm that inherited them would fire on the tail of the
      // utterance that just ended.
      vad = createEnergyFrameVad(vadTuning);
    },
    async dispose(): Promise<void> {},
  };
}

export async function startListenDaemon(
  pre: ListenPreflight,
  flags: ListenFlags,
  ctx: ListenDaemonContext,
): Promise<void> {
  const deviceInfo = pre.device;
  if (deviceInfo === null) return;

  const { storage, device } = ctx;
  // Every line this daemon narrates goes through here — see `writerFor`.
  const say = writerFor(flags);

  // The `--route` PIN, resolved against the table the server pushes rather than
  // the local config — which is why it is a `let` assigned after connect. Null
  // is the ordinary case: unpinned, every phrase in the table may address this
  // microphone.
  let route: WakeRoute | null = null;
  let machine: CaptureMachine | null = null;
  /**
   * Drives the loudspeaker and owns the re-arm receipt. Null on a host with no
   * player. Assigned just below the client for the same reason `machine` is
   * assigned late: the playout sends frames and the client feeds the playout.
   */
  let playout: SatellitePlayout | null = null;
  let captureState: CaptureState = 'idle';
  let wakeSeq = 0;
  let utteranceSeq = 0;
  /**
   * The utterance this daemon has printed a `●` for and NOT yet resolved.
   *
   * Local only. Set at speech onset, which is now earlier than the wake — the
   * `CaptureMachine` holds the wake until the utterance clears its
   * minimum-speech floor, so between onset and qualification there is an
   * utterance this terminal has named and the server has never heard of. This
   * is what the discard notice pairs against; `currentUtteranceId` below cannot,
   * because for a discarded utterance it is never set at all.
   */
  let openUtteranceId: string | null = null;
  /** The utterance the SERVER knows about. Null until the wake is released. */
  let currentUtteranceId: string | null = null;
  let audioSeq = 0;
  /** The no-loudspeaker notice, said once per process and never again. */
  let playoutWarned = false;
  /**
   * The player-refused-this-reply notice, also once.
   *
   * Separate from `playoutWarned` because they are different facts with
   * different remedies — "you have no player" and "your player cannot open what
   * the server sends" — and collapsing them would print the wrong instruction
   * on whichever host hit the other one.
   */
  let playoutProblemWarned = false;
  /**
   * Frames HELD for on-device transcription, and how many bytes of them.
   *
   * Only ever non-empty on the edge path: on the audio path a frame is on the
   * wire before the next one arrives, and holding it would be latency bought
   * for nothing.
   */
  let edgeFrames: WakeFrame[] = [];
  let edgeBytes = 0;
  /** This utterance hit `EDGE_UTTERANCE_MAX_BYTES` and is missing its tail. */
  let edgeTruncated = false;
  /**
   * The turn's closing line, waiting for the speaker to stop. See `closingLine`.
   * Always null on a host with no playout, which prints it inline.
   */
  let pendingClose: string | null = null;
  /** What was last REGISTERED with the server; see `onSetWakeEnabled`. */
  let wakeEnabled = true;
  /** Whether the pinned route's absence has already been said; see `onRoutes`. */
  let routeMissingWarned = false;
  /**
   * WHAT ALREADY HAPPENED to the utterance whose turn has not closed yet.
   *
   * `turn_end` is not enough to close an utterance honestly. It says who
   * answered, and nothing about the three ways nobody did: the server heard no
   * speech, the server REFUSED the route somebody named, or the words were
   * addressed to no one. The last is the only one the closing line used to
   * describe, so a refusal — privileged personality, disabled route, unknown
   * personality — printed "not addressed to anyone … open with a personality's
   * name" directly under an error saying the name they used is the problem.
   * Two contradicting lines, and the false one is the one that says what to do
   * next.
   *
   * So the frames that DO know are remembered here, keyed by the utterance they
   * described, and `turn_end` reads the record rather than inferring from
   * itself. Keyed rather than a bare flag because an error can arrive with no
   * utterance in flight (a socket that would not open, a frame that would not
   * decode), and that must not colour the next turn's closing line.
   */
  let outcome: { utteranceId: string; kind: 'refused' | 'no-speech' } | null = null;
  /**
   * The addressing window the SERVER is enforcing, from the pushed settings.
   *
   * Read off the wire rather than off this machine's `config.yaml`: the gate
   * runs on the server, so the server's number is the one a banner may quote.
   * The local value is only a placeholder until the first push lands.
   */
  let idleWindowMs = pre.idleTimeoutMs ?? DEFAULT_IDLE_WINDOW_MS;

  let deliverTable: ((routes: WakeRoute[]) => void) | null = null;
  const firstTable = new Promise<WakeRoute[]>((resolve) => {
    deliverTable = resolve;
  });

  /**
   * The loudspeaker, or null. PROBED, NOT DECLARED — `pre.player` is the answer
   * `resolvePlayer` got from PATH (or the operator's own `--play`), and a null
   * here is what makes `capabilities.playback: false` a fact rather than a
   * historical constant.
   */
  const playbackDevice: PlaybackDevice | null =
    ctx.playbackDevice ??
    (pre.player.player === null
      ? null
      : createCommandPlaybackDevice({ player: pre.player.player }));

  /**
   * The recognizer that runs HERE, or null. Gated on the preflight's verdict
   * and not on the config flag, so a provider that resolved but was refused for
   * not being local cannot slip through as "edge STT" on the wire.
   */
  const edgeSttProvider: SttProvider | null =
    pre.edgeStt.enabled && ctx.edgeSttProvider !== undefined ? ctx.edgeSttProvider : null;

  // The client's callbacks reach `machine`, which is constructed after the
  // route table lands. They are null-guarded rather than ordered: the socket
  // genuinely is open before the machine exists, and the two are mutually
  // referential by nature — the machine drives the wire and the wire re-arms
  // the machine.
  const transport = ctx.createSocket;
  const auth = transport === undefined ? await authCookie(storage) : {};
  const client = createSatelliteClient({
    url: pre.url,
    nodeId: pre.nodeId,
    displayName: pre.nodeId,
    capabilities: {
      // ALL FOUR ARE OUTCOMES, NOT INTENTIONS. `edgeStt` is true only when a
      // recognizer with `caps.local` actually constructed on this machine;
      // `playback` only when a player was actually found. Declaring either
      // optimistically is worse than declaring it false: the server STOPS
      // sending audio to an edge node and STARTS spending TTS on a playback
      // one, so an optimistic claim buys silence at one end or a wasted
      // provider call at the other. `phraseMatch` stays false — nothing here
      // compares sound to a phrase, so the SERVER gates, from the transcript.
      edgeStt: edgeSttProvider !== null,
      playback: playbackDevice !== null,
      captureSampleRate: pre.sampleRate,
      phraseMatch: false,
    },
    wakeEnabled: true,
    ...auth,
    ...(transport === undefined ? {} : { createSocket: transport }),
    onRoutes: (frame) => {
      const table: WakeRoute[] = frame.routes.map((r) => ({ ...r }));
      idleWindowMs = frame.settings.idleTimeoutMs;
      const deliver = deliverTable;
      if (deliver !== null) {
        // The FIRST table is the one the route is chosen from — it is the only
        // authority on what this deployment answers to.
        deliverTable = null;
        deliver(table);
        return;
      }
      // A later push is a Settings save or a reconnect. Unpinned, there is
      // nothing to check: the server matches every transcript against whatever
      // table it holds, and this host does not have an opinion to go stale.
      const active = route;
      if (active === null) return;
      const present = table.some((r) => r.id === active.id && r.enabled);
      // NARRATED ON THE EDGE, BOTH WAYS. Every reconnect and every Settings
      // save re-pushes the table, so warning on each push repeated one line per
      // push for a condition that had not changed — and saying nothing when the
      // route came back left "utterances will be refused until it comes back"
      // standing as the operator's last word on a satellite that was working
      // again.
      if (!present && !routeMissingWarned) {
        routeMissingWarned = true;
        say(
          `${c.yellow}⚠ route${c.reset} ${c.dim}the server no longer has an enabled route ` +
            `'${active.id}' — this host is pinned to it, so nothing said here can reach ` +
            `an agent until it comes back.${c.reset}`,
        );
        return;
      }
      if (present && routeMissingWarned) {
        routeMissingWarned = false;
        say(
          `${c.dim}  ↩ route '${active.id}' is back in the server's table — ` +
            `"${active.phrase}" reaches ${active.personalityId} again.${c.reset}`,
        );
      }
    },
    onTranscript: (frame) => {
      // What the server HEARD, echoed back — printed as the operator's own
      // words, with `onReplyText` below printing the answer to them.
      if (!frame.final) return;
      if (frame.text.trim() === '') {
        outcome = { utteranceId: frame.utteranceId, kind: 'no-speech' };
        // A FINAL TRANSCRIPT WITH NO TEXT IS THE SERVER SAYING IT HEARD NO
        // SPEECH — the recognizer's own "nothing was said", which on an open
        // pipe in a room is ordinary traffic and not a fault. It arrives with a
        // `turn_end` behind it, so the re-arm is already narrated below and
        // this line only has to say what was heard. Rendering it through the
        // normal branch printed a bare `› you:` with nothing after it, which
        // reads as a bug; any word stronger than these blames the operator for
        // a door closing.
        say(
          `${c.dim}  › no speech in that audio — the server heard nothing to transcribe.${c.reset}`,
        );
        return;
      }
      say(`${c.dim}  › you:${c.reset} ${frame.text}`);
    },
    onReplyText: (frame) => {
      // The other half of the exchange, printed WHETHER OR NOT it is also
      // spoken. On a host with no loudspeaker this line is the only way the
      // answer arrives at all; on one with a player it is still the transcript
      // of what the room just heard, which is what makes a mis-synthesized or
      // half-drained reply diagnosable instead of merely disappointing.
      say(
        `${c.dim}  ‹ ${c.reset}${c.cyan}${frame.personalityId}${c.reset}${c.dim}:${c.reset} ${frame.text}`,
      );
    },
    onSpeak: (event) => {
      if (event.type === 'speak_start' && playbackDevice === null && !playoutWarned) {
        playoutWarned = true;
        say(
          `${c.yellow}⚠ playout${c.reset} ${c.dim}the server is sending synthesized audio, ` +
            `and this host has no player (capabilities.playback: false). ` +
            `The audio is being discarded — the reply text still prints below. ` +
            `${pre.player.detail}${c.reset}`,
        );
      }
      if (event.type === 'turn_end') {
        const line = closingLine(event.utteranceId, event.personalityId);
        currentUtteranceId = null;
        // EVERY ONE OF THOSE LINES ENDS IN "listening again", so on a host that
        // is about to play four seconds of audio none of them is true yet.
        // Held and said by `finishPlayout`, at the moment it becomes true. A
        // host with no playout prints it here exactly as it always did.
        if (playout === null) say(line);
        else pendingClose = line;
      }
      // THE RE-ARM MOVED BEHIND THE SPEAKER. `playback_done` means "the speaker
      // has gone quiet and I am listening again", and it used to be sent from
      // the branch above — honest on a host with no loudspeaker, and a lie the
      // moment one exists: re-arming into the agent's own voice is the
      // self-wake the suppression window exists to stop. So the playout owns
      // the receipt now (it fires `onDone` when the device's `end()` resolves,
      // or when its drain watchdog gives up), and a host with no playout keeps
      // the immediate path because it satisfies "the speaker is quiet"
      // trivially.
      if (playout !== null) {
        playout.handle(event);
        return;
      }
      if (event.type === 'turn_end') finishPlayout(event.utteranceId, false);
    },
    onSetWakeEnabled: (enabled) => {
      machine?.setMuted(!enabled);
      // A MUTED SATELLITE IS A DEAF ONE, and rule 1 of this file says it may
      // never look otherwise. The mute arrives from the Settings UI on another
      // machine, and `onStateChange` deliberately narrates nothing for `muted`
      // (it is a legitimate state, not a fault) — so without this line the pipe
      // keeps flowing, `●` never appears again, and the terminal that said
      // "Listening on ..." is the last thing the operator was told.
      if (enabled === wakeEnabled) return;
      wakeEnabled = enabled;
      say(
        enabled
          ? `${c.dim}  ↩ wake re-enabled from the server. Listening again.${c.reset}`
          : `${c.yellow}⚠ wake${c.reset} ${c.dim}disabled from the server — this node is muted, ` +
              `and speech on the pipe is ignored until it is re-enabled.${c.reset}`,
      );
    },
    onError: (message, detail) => {
      say(`${c.yellow}⚠ satellite${c.reset} ${c.dim}${message}${c.reset}`);
      // Only a server `error` frame naming an utterance changes how that
      // utterance's turn closes. A transport report carries no detail, and a
      // lane-wide refusal names no utterance — neither is evidence about the
      // one in flight, and guessing would put "the error above says why" under
      // a turn the error above had nothing to do with.
      const refused = detail?.utteranceId;
      if (refused !== undefined) outcome = { utteranceId: refused, kind: 'refused' };
    },
  });

  /**
   * HOW A TURN CLOSES, in one line the operator can act on.
   *
   * FOUR WAYS A TURN ENDS, and the operator is owed the difference — because
   * the next thing they should do differs in every one. Two questions decide
   * it, and neither can be answered by the `turn_end` frame alone: was an agent
   * called (`personalityId`), and did the server already say something went
   * wrong with this utterance (`outcome`).
   *
   * Ordered so the error-carrying branches come first within each half: a line
   * that closes a turn while contradicting the error above it is the defect
   * this shape exists to make impossible.
   *
   * Returns the line rather than printing it, because WHEN it is printed now
   * depends on the speaker — see the `turn_end` branch in `onSpeak`.
   */
  function closingLine(utteranceId: string, personalityId: string | undefined): string {
    const known = outcome?.utteranceId === utteranceId ? outcome.kind : null;
    outcome = null;
    if (personalityId !== undefined) {
      return known === 'refused'
        ? `${c.dim}  ↩ the turn did not finish — the error above says why. Listening again.${c.reset}`
        : `${c.dim}  ↩ turn complete. Listening again.${c.reset}`;
    }
    if (known === 'refused') {
      // A phrase MATCHED and the server declined it. Saying "not addressed to
      // anyone" here is false — they addressed someone, by a name the server
      // holds — and "open with a personality's name" sends them to repeat the
      // thing that just worked instead of to the route setting the error names.
      return (
        `${c.dim}  ↩ no agent was called — the error above says why. ` +
        `Listening again.${c.reset}`
      );
    }
    if (known === 'no-speech') {
      // Nothing was said, so nothing was left unaddressed. `onTranscript` has
      // already printed what was heard; this only re-arms.
      return `${c.dim}  ↩ listening again.${c.reset}`;
    }
    // Heard, transcribed, addressed to nobody — the COMMON case in a room, and
    // the only one where the remedy really is a wake phrase.
    return (
      `${c.dim}  ↩ not addressed to anyone — no agent was called. ` +
      `Open with a personality's name to reach one. Listening again.${c.reset}`
    );
  }

  /**
   * The microphone comes back. ONE function, whichever end decided it was time
   * — the playout draining, the drain watchdog giving up, or a host with no
   * loudspeaker for which the speaker was never busy.
   *
   * `timedOut` is not a different code path, only a different sentence: the
   * re-arm happens either way, because a satellite that stayed deaf because its
   * player wedged is the failure this lane refuses above all others. It is said
   * BEFORE the closing line, so the "Listening again" the operator reads has
   * the caveat directly above it rather than trailing behind.
   */
  function finishPlayout(utteranceId: string, timedOut: boolean): void {
    if (timedOut) {
      say(
        `${c.yellow}⚠ playout${c.reset} ${c.dim}the player never reported the speaker draining ` +
          `for utterance ${utteranceId} — listening again anyway, without a drained-playout ` +
          `receipt. A reply may still be audible while this microphone is live.${c.reset}`,
      );
    }
    const line = pendingClose;
    pendingClose = null;
    if (line !== null) say(line);
    client.sendPlaybackDone(utteranceId);
    machine?.endPlayback();
  }

  /**
   * Transcribe one utterance HERE and send the words, never the samples.
   *
   * WHAT HAPPENS WHEN THE RECOGNIZER FAILS is the interesting half, and there
   * is exactly one acceptable answer. Falling back to the audio path would
   * upload the room the operator asked to keep private — the worst possible
   * response to a local failure — and sending nothing would leave the server
   * holding an utterance it will never close, which parks this microphone in
   * `speaking` until the capture watchdog fires minutes later. So the utterance
   * closes as an EMPTY transcript: the server matches it against nobody, sends
   * `turn_end`, and this node re-arms. Loudly, because an operator whose
   * recognizer is broken must not read the silence as a quiet room.
   *
   * The staleness check is the same discipline the audio path has: a transcript
   * for an utterance that has already been superseded is dropped rather than
   * attached to whatever is in flight now.
   */
  async function transcribeOnDevice(
    provider: SttProvider,
    utteranceId: string,
    frames: WakeFrame[],
    truncated: boolean,
  ): Promise<void> {
    let text: string;
    try {
      text = await provider.transcribeBuffer({
        data: encodeUtteranceWav(frames, pre.sampleRate),
        mimeType: 'audio/wav',
      });
    } catch (err) {
      say(
        `${c.yellow}⚠ edge stt${c.reset} ${c.dim}on-device transcription failed: ` +
          `${err instanceof Error ? err.message : String(err)}. The utterance was discarded ` +
          `and NO audio was sent upstream — edge mode does not fall back to uploading the ` +
          `room. Listening again.${c.reset}`,
      );
      text = '';
    }
    if (currentUtteranceId !== utteranceId) return;
    if (truncated) {
      say(
        `${c.yellow}⚠ edge stt${c.reset} ${c.dim}utterance ${utteranceId} exceeded ` +
          `${EDGE_UTTERANCE_MAX_BYTES} bytes and was transcribed without its tail.${c.reset}`,
      );
    }
    client.sendTranscript(utteranceId, text);
  }

  if (playbackDevice !== null) {
    playout = new SatellitePlayout({
      device: playbackDevice,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onDone: ({ utteranceId, timedOut }) => finishPlayout(utteranceId, timedOut),
      onProblem: (problem) => {
        // The watchdog says its own piece in `finishPlayout`, next to the
        // re-arm it caused; repeating it here would print the same failure
        // twice under two different headings.
        if (problem.kind === 'watchdog') return;
        if (playoutProblemWarned) return;
        playoutProblemWarned = true;
        say(
          `${c.yellow}⚠ playout${c.reset} ${c.dim}${problem.reason} The reply text still ` +
            `prints; said once, not once per turn.${c.reset}`,
        );
      },
    });
  }

  // Both are assigned further down, but the signal handlers below are installed
  // FIRST: Ctrl+C during the wait for the server's route table must still stop
  // the process rather than being ignored until capture starts.
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let stopWatchdog: (() => void) | null = null;
  let shuttingDown = false;
  const leave = ctx.exit ?? ((code: number): void => process.exit(code));
  /**
   * The ONE way this daemon leaves, whatever asked it to.
   *
   * `code` is the whole difference between a deliberate Ctrl+C and a capture
   * device that died: the teardown — health file removed, socket closed,
   * watchdog stopped — is identical and must not be skipped by either, which is
   * why the pipe-closed path comes through here rather than calling
   * `process.exit` where it noticed.
   */
  const shutdown = async (code: number): Promise<void> => {
    // A Ctrl+C landing on top of a capture end (or a SIGTERM on top of a
    // SIGINT) must not run the teardown twice.
    if (shuttingDown) return;
    shuttingDown = true;
    say(`\n${c.dim}Shutting down...${c.reset}`);
    if (stopWatchdog) stopWatchdog();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await storage.remove(listenHealthPath()).catch(() => {});
    client.close();
    // `cancel`, not a drain: a Ctrl+C that waited politely for the agent to
    // finish its sentence would be a daemon that ignores Ctrl+C.
    playout?.cancel();
    machine?.stop();
    await device.stop().catch(() => {});
    leave(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  client.connect();
  say(
    `${c.dim}Connecting to ${pre.url} for the wake route table` +
      `${pre.requestedRoute === undefined ? '' : ` (pinning to route ${pre.requestedRoute})`}...${c.reset}`,
  );

  // READY MEANS "UP AND CONNECTING", not "capturing". A satellite booted before
  // `ethos serve` waits here for as long as the server takes, and a supervisor
  // that never got a readiness notification would kill it on its start timeout.
  emitReady('listen');
  notifyReady();
  stopWatchdog = startWatchdog();

  const pushed = await firstTable;
  const pin = resolveRoutePin(pushed, flags.route);
  // Only a pin that names nothing is fatal — the operator asked for a specific
  // route and did not get it, and starting anyway would leave the microphone
  // answering to phrases they meant to exclude.
  if (pin.problem !== undefined) {
    console.error(`${c.red}✗ ${pin.problem}${c.reset}`);
    if (stopWatchdog) stopWatchdog();
    client.close();
    process.exitCode = 1;
    return;
  }
  const pinnedRoute = pin.route;
  route = pinnedRoute;
  if (pushed.filter((r) => r.enabled).length === 0) {
    say(`${c.yellow}⚠ routes${c.reset} ${c.dim}${EMPTY_TABLE_WARNING}${c.reset}`);
  }

  const engine = createOpenMicEngine(pre.vadTuning);
  // The engine matches nothing, so the routes and the sensitivity it is handed
  // decide nothing either — they are the seam's shape, not this host's policy.
  // The table that matters is the server's, applied to the transcript.
  await engine.init([], { sensitivity: 0.5, confirmationFrames: 1 });

  const capture = new CaptureMachine(
    {
      engine,
      vad: createEnergyFrameVad(pre.vadTuning),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      // SPEECH ONSET IS A TERMINAL EVENT, NOT A WIRE EVENT. The `●` is what
      // tells an operator the pipe is alive and the microphone is hearing the
      // room, so it stays where it always was — at onset, before anything is
      // known about whether the noise was a request. Nothing is sent from here:
      // the machine holds the wake until the utterance clears its
      // minimum-speech floor, which is what stops every chair scrape from
      // opening a server-side utterance that nothing ever closes.
      onSpeechStart: () => {
        openUtteranceId = `u${++utteranceSeq}-${Date.now().toString(36)}`;
        // No personality on this line, because none has been chosen: the words
        // decide, and nobody has heard them yet. Claiming one here is what the
        // old push-to-talk banner did, and it was wrong the moment two
        // personalities shared a microphone.
        say(
          `${c.dim}● speech — utterance ${openUtteranceId} open${c.reset}` +
            `${pinnedRoute === null ? '' : `${c.dim} (pinned to route ${pinnedRoute.id}).${c.reset}`}`,
        );
      },
      // The utterance earned its keep. NOW the server hears about it, and the
      // held frames follow immediately behind on `onAudio`.
      onWake: (match) => {
        const stamp = Date.now().toString(36);
        const wakeId = `w${++wakeSeq}-${stamp}`;
        // The id the `●` line already printed. Only minted here if speech onset
        // somehow did not run — the two must never name the same utterance
        // differently in the same terminal.
        const utteranceId = openUtteranceId ?? `u${++utteranceSeq}-${stamp}`;
        currentUtteranceId = utteranceId;
        audioSeq = 0;
        // Whatever the last utterance left behind goes with it. On the edge
        // path a re-arm through the watchdog can strand held frames, and
        // transcribing THOSE against this utterance would put the previous
        // room's words in front of a personality that was never told them.
        edgeFrames = [];
        edgeBytes = 0;
        edgeTruncated = false;
        client.sendWake({
          wakeId,
          // No phrase and no personality: this engine matched SOUND. `routeId`
          // from a `phraseMatch: false` node is the PIN — "only this route may
          // address me" — not a claim that it matched.
          ...(pinnedRoute === null ? {} : { routeId: pinnedRoute.id }),
          confidence: match.confidence,
        });
        client.sendUtteranceStart({ wakeId, utteranceId, sampleRate: pre.sampleRate });
      },
      onAudio: (frame) => {
        const utteranceId = currentUtteranceId;
        if (utteranceId === null) return;
        if (edgeSttProvider !== null) {
          // HELD, NOT SENT — and this is the entire privacy claim, expressed as
          // a branch that has no `client.sendAudio` in it. The recognizer runs
          // on this box at `onUtteranceEnd`; nothing on this path can put a
          // sample on the wire, which is a stronger guarantee than a flag the
          // server is trusted to honour.
          const bytes = frame.samples.length * 2;
          if (edgeBytes + bytes > EDGE_UTTERANCE_MAX_BYTES) {
            edgeTruncated = true;
            return;
          }
          edgeBytes += bytes;
          edgeFrames.push(frame);
          return;
        }
        client.sendAudio(utteranceId, audioSeq++, frame.samples);
      },
      onUtteranceEnd: () => {
        openUtteranceId = null;
        if (currentUtteranceId === null) return;
        if (edgeSttProvider === null) {
          client.sendUtteranceEnd(currentUtteranceId);
        } else {
          // The transcript IS the end of the utterance on an edge node — the
          // wire contract makes `transcript` and `audio`/`utterance_end`
          // alternatives, and the client refuses the second kind for an
          // utterance that already sent the first. Detached, because
          // recognition takes as long as it takes and the frame handlers
          // (`state`, the next wake) must not queue behind it.
          const frames = edgeFrames;
          const truncated = edgeTruncated;
          edgeFrames = [];
          edgeBytes = 0;
          edgeTruncated = false;
          void transcribeOnDevice(edgeSttProvider, currentUtteranceId, frames, truncated);
        }
        // The machine has no "waiting for the server" state, and `thinking` has
        // no watchdog — so the window between utterance_end and turn_end is
        // modelled as playback. It is the interval in which the reply is being
        // produced, the microphone must stay suppressed through it, and the
        // playback watchdog is the ONLY supervision that guarantees a re-arm if
        // `turn_end` never arrives. Without this the daemon is the classic
        // "capture loop survives exactly one turn".
        capture.beginPlayback();
      },
      onStateChange: (state, detail) => {
        captureState = state;
        client.sendState(protocolState(state), detail);
        if (state === 'degraded' && detail) {
          say(`${c.yellow}⚠ capture${c.reset} ${c.dim}${detail}${c.reset}`);
          return;
        }
        // A `listening` transition CARRYING A DETAIL is `CaptureMachine`
        // discarding an utterance under its minimum-speech floor — the only
        // detailed re-arm it has (the watchdog's re-arm reports itself as
        // `degraded` first, and passes none).
        //
        // THE REPETITION RULE IS PAIRING: narrate it only while an utterance
        // this daemon already printed a `● speech` line for is unresolved, and
        // resolve it here. That gives exactly one discard line per `●`, never
        // one without a `●`, so the dangling open marker this fixes cannot come
        // back — and in a room full of chair scrapes it adds no NEW class of
        // noise, because every discard had already cost a `●` line and this one
        // closes it rather than adding an unrelated one. Suppressing
        // consecutive duplicates instead would leave that dangling `●` standing
        // in exactly the noisy case it was meant to help: the details differ by
        // their millisecond count, so consecutive discards are rarely identical.
        //
        // Paired against the LOCALLY open utterance, not the one the server
        // knows about: a discarded utterance never had a wake released for it,
        // so `currentUtteranceId` is null on exactly the path this line exists
        // to narrate.
        if (state === 'listening' && detail !== undefined && openUtteranceId !== null) {
          say(`${c.dim}  ↩ ${detail}${c.reset}`);
          // Nothing about this utterance went upstream — no wake, no audio, no
          // `utterance_end`, and there is no turn to close. Clearing it is what
          // makes the next `●` the only open one.
          openUtteranceId = null;
          currentUtteranceId = null;
        }
      },
    },
    pre.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: pre.idleTimeoutMs },
  );
  machine = capture;

  /**
   * Frames the device has handed over since it opened.
   *
   * Only ever read to choose the diagnosis below, and the distinction is the
   * whole value of it: zero frames means the capture command never produced a
   * sample, which points at the command line; any frames means it worked and
   * then stopped, which does not.
   */
  let framesCaptured = 0;

  /**
   * The device is gone, and this daemon does not get to keep saying otherwise.
   *
   * THE LIE THIS FIXES: `ffmpeg` exits on a bad `-i :2`, its end of the pipe
   * closes, and the daemon sits under a "Listening on ..." banner forever while
   * the operator works out for themselves that nothing is happening. stdin
   * cannot be reopened — there is no recovery to attempt, no backoff that could
   * help, and staying up IS the false-available failure rule 1 of this file
   * forbids. So it says what happened, names the likely cause when the frame
   * count knows it, and leaves non-zero through the ordinary shutdown.
   */
  async function onCaptureEnded(end: CaptureEnd): Promise<void> {
    if (shuttingDown) return;
    // stderr for both branches: this is a process explaining why it is dying,
    // and under `--json` stdout belongs to the doctor's object alone.
    if (framesCaptured === 0) {
      console.error(
        `\n${c.red}✗ capture${c.reset} ${end.reason} before a single audio frame arrived — ` +
          `nothing was ever heard on this satellite.\n` +
          `  The capture command almost certainly failed to start: a device index that does not ` +
          `exist, or a denied microphone permission, exits immediately and closes the pipe.\n` +
          `  List this host's input devices with ${c.bold}${listDevicesHint()}${c.reset} and ` +
          `re-run the pipeline with the index it reports.`,
      );
    } else {
      console.error(
        `\n${c.yellow}⚠ capture${c.reset} ${end.reason} after ${framesCaptured} frame(s) — ` +
          `the capture command ended. Nothing more can be heard.`,
      );
    }
    console.error('  The pipe cannot be reopened, so this satellite is stopping.');
    await shutdown(CAPTURE_ENDED_EXIT);
  }

  await device.start(
    (frame) => {
      framesCaptured++;
      capture.pushFrame(frame);
    },
    (end) => void onCaptureEnded(end),
  );
  capture.start();

  // THE ONE SENTENCE A PERSON NEEDS, and the one this host could not give
  // before: what happens to everything it hears, and what makes an agent
  // answer. Both halves are load-bearing — the first is a privacy fact, the
  // second is the whole interaction model.
  say(
    `${c.dim}Open mic: EVERYTHING heard here is transcribed ` +
      `${
        edgeSttProvider === null
          ? 'by the server'
          : `ON THIS MACHINE by ${pre.edgeStt.providerId ?? 'the local recognizer'} — no captured audio leaves it`
      }. An utterance ` +
      `reaches an agent only when it OPENS with a personality's NAME — that name picks the ` +
      `personality, and a greeting in front of it is optional — and follow-ups within ` +
      `${Math.round(idleWindowMs / 1000)}s ` +
      `continue with the same one. Anything else is heard and discarded.${c.reset}`,
  );
  // Said at startup rather than at the first reply, because "will this thing
  // talk back?" is a question the operator has while they are still standing in
  // front of it — not one they should discover from the absence of a sound.
  say(
    playbackDevice === null
      ? `${c.yellow}⚠ speaker${c.reset} ${c.dim}replies here are TEXT ONLY — ${pre.player.detail}${c.reset}`
      : `${c.dim}Replies are spoken through ${c.reset}${c.bold}${pre.player.player?.kind ?? 'the configured player'}${c.reset}${c.dim}; the text prints too.${c.reset}`,
  );
  if (pinnedRoute === null) {
    const addressable = pushed.filter((r) => r.enabled);
    say(
      `${c.dim}Addressable here — say one of these:${c.reset} ` +
        (addressable.length === 0
          ? `${c.dim}nothing yet — the server pushed an empty table.${c.reset}`
          : `${addressable.map(addressableEntry).join(`${c.dim},${c.reset} `)}` +
            `${c.dim}. A greeting in front of it ("hey …") is optional.${c.reset}`),
    );
  } else {
    say(
      `${c.dim}Pinned by --route: only${c.reset} ${c.bold}"${pinnedRoute.phrase}"${c.reset} ` +
        `${c.dim}→${c.reset} ${c.cyan}${pinnedRoute.personalityId}${c.reset}${c.dim} ` +
        `(route ${pinnedRoute.id}, ` +
        `${pinnedRoute.id.startsWith('auto:') ? 'synthesized by the server for this personality' : 'from voice.wake.routes'}` +
        `) can address this microphone. Other phrases are heard and discarded.${c.reset}`,
    );
  }
  // "close the pipe to stop talking" used to be a half-truth: the pipe closed
  // and this line stayed on screen over a daemon that could no longer hear.
  // Closing it now ENDS the satellite, and the sentence says which.
  say(
    `${c.dim}Listening on ${deviceInfo.label}. Press Ctrl+C to stop; closing the pipe ` +
      `stops this satellite (stdin cannot be reopened).${c.reset}\n`,
  );

  const startedAt = new Date().toISOString();
  const writeHeartbeat = async (): Promise<void> => {
    const beat: ListenHeartbeat = {
      pid: process.pid,
      startedAt,
      updatedAt: new Date().toISOString(),
      adapters: [
        { name: 'satellite', ok: client.isOpen() },
        { name: 'capture', ok: captureState !== 'degraded' && captureState !== 'muted' },
      ],
      captureState,
    };
    await storage.writeAtomic(listenHealthPath(), JSON.stringify(beat)).catch(() => {
      // Best-effort — a missed tick is harmless; the reader treats stale data
      // as degraded, exactly as it does for the gateway.
    });
  };
  void writeHeartbeat();
  heartbeatTimer = setInterval(() => void writeHeartbeat(), HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  ctx.onReady?.();
  await new Promise(() => {});
}
