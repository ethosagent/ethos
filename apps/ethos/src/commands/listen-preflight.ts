// `ethos listen` — the preflight result and everything derived from it: the
// exit code, the fail flags, the URLs, the node id and the doctor-row renames.
// Split out of listen.ts.

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import type { Storage } from '@ethosagent/types';
import type {
  AudioDeviceInfo,
  DoctorProbeRow,
  SatelliteSocketFactory,
  WakeRoute,
} from '@ethosagent/voice-satellite';
import { SATELLITE_SOCKET_PATH } from '@ethosagent/web-contracts';
import { WARN_EXIT } from './_shared';
import type { EdgeSttReport } from './listen-edge-stt';
import type { PlayerResolution } from './listen-player';

/** `ethos serve --web-port` default. Mirrors WEB_PORT_DEFAULT in serve-helpers.ts. */
const DEFAULT_WEB_PORT = 3000;

/**
 * What this host calls the reachability row — in the printed row, the `--json`
 * probe name, and the prose.
 *
 * NOT `gateway`, which is what the shared satellite doctor still names it. That
 * name was true when the row probed `/healthz`; it stopped being true when the
 * probe was repointed at `/satellite/ws` (see `probeSatelliteLane`), and a row
 * labelled `gateway` sends an operator whose satellite cannot connect off to
 * look at their Telegram bot. The rename happens once, in `realPreflight`, so
 * everything downstream — the row, the flags, the JSON — agrees.
 */
export const LANE_PROBE_NAME = 'satellite-lane';

/** The shared doctor's name for the row `LANE_PROBE_NAME` replaces. */
const SHARED_DOCTOR_LANE_PROBE_NAME = 'gateway';

/** The shared doctor's rows, under the names this host prints and reports. */
export function withLaneProbeName(probes: readonly DoctorProbeRow[]): DoctorProbeRow[] {
  return probes.map((p) =>
    p.name === SHARED_DOCTOR_LANE_PROBE_NAME ? { ...p, name: LANE_PROBE_NAME } : p,
  );
}

/**
 * What a passing `microphone` row on a pipe-fed host does NOT prove.
 *
 * The probe asks the device to enumerate, and this device enumerates on one
 * fact: stdin is not a TTY. That is true and nearly useless — a pipe with a
 * healthy `ffmpeg` behind it and a pipe whose `ffmpeg` died on a bad `-i :2`
 * are byte-identical from here, and only consuming bytes could tell them apart,
 * which a preflight must not do to audio the daemon is about to need. So the
 * row keeps its ✓ (a working pipeline is genuinely fine) and says what it
 * cannot see, rather than letting `1 input device(s)` read as proven capture.
 */
const PIPE_PROVES_ONLY_A_PIPE =
  'stdin is a pipe, which is ALL this proves: whether anything is WRITING to it ' +
  'cannot be known without consuming the audio, so a capture command that died on ' +
  'startup looks identical here. `ethos listen` reports it the moment the pipe closes.';

/**
 * The `microphone` row with the caveat this host — and only this host — can add.
 *
 * Applied here rather than in the shared doctor because the caveat is a fact
 * about THIS device: a desktop enumerating real inputs through a real binding
 * has genuinely proven something, and would be made to apologize for it.
 */
export function withPipeCaveat(probes: readonly DoctorProbeRow[]): DoctorProbeRow[] {
  return probes.map((p) =>
    p.name === 'microphone' && p.ok && p.skipped !== true
      ? {
          ...p,
          detail: `${p.detail === undefined ? '' : `${p.detail} — `}${PIPE_PROVES_ONLY_A_PIPE}`,
        }
      : p,
  );
}

// ---------------------------------------------------------------------------
// Preflight result — everything both the doctor and the banner render
// ---------------------------------------------------------------------------

export interface ListenPreflight {
  /** One row per probe, straight from `runSatelliteDoctor`. */
  probes: DoctorProbeRow[];
  /** `voice.wake.engine`, normalized to the engine's own name. */
  configuredEngine: string;
  /**
   * True when `transcriptWakeEngineFactory` probed OK — the dependency-free
   * engine every build is supposed to have.
   *
   * The daemon does not run it (it runs the open-mic engine and the SERVER
   * matches phrases), but its probe is the floor: it loads no binding and no
   * model, so a failure there means the satellite package itself is broken on
   * this host and nothing about the wake stack can be believed. That is the
   * one failure this command refuses to start through.
   */
  transcriptEngineOk: boolean;
  /**
   * True when the configured engine reads model files. The shared doctor probes
   * the model directory unconditionally because most satellite hosts run an
   * acoustic engine; this host knows which engine it will run, so it — not the
   * shared probe — decides whether an empty model directory is fatal.
   */
  modelsRequired: boolean;
  /** Satellite lane URL the daemon would connect to. */
  url: string;
  /** HTTP health URL the lane probe falls back to. */
  healthUrl: string;
  /**
   * Why the `satellite-lane` row failed, in a form a script can branch on: the
   * errno where the failure had one (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`),
   * or a probe token where it did not (`NO_SATELLITE_LANE`, `HTTP_500`).
   *
   * Carried beside the probes rather than on them because `DoctorProbeRow` is
   * the satellite wire shape — `{name, ok, detail}` and nothing else — and the
   * shared doctor drops any field it does not know. Absent when the lane is
   * reachable, or when no probe ran.
   */
  laneFailureCode?: string;
  /** Stable across restarts. See `resolveListenNodeId`. */
  nodeId: string;
  /**
   * Enabled `voice.wake.routes` entries from the LOCAL config, id-ordered.
   *
   * A HINT, NOT THE TABLE. The effective table is the server's — it merges
   * these with a synthesized `auto:<personalityId>` route per unprivileged
   * personality and pushes the result on connect — so an empty list here says
   * nothing about what this deployment answers to. The daemon resolves its
   * route against the pushed table; this field only tells the operator what
   * their own file contributes.
   */
  routes: WakeRoute[];
  /** `--route`, unresolved: only the pushed table can validate the pin. */
  requestedRoute?: string;
  /**
   * Whether an on-device recognizer resolved, and which one — the answer to
   * "does this room's audio leave the machine?". Probed, never read off the
   * config flag: `voice.wake.edgeStt` is an intent and this is the outcome.
   */
  edgeStt: EdgeSttReport;
  /** The player that would be spawned for a reply, or the reason there is none. */
  player: PlayerResolution;
  /** The capture device that would be opened, or null when there is none. */
  device: AudioDeviceInfo | null;
  sampleRate: number;
  /**
   * `voice.wake.idleTimeout`, in ms. Ends LISTENING only, never the session.
   * Absent when the operator set none — `CaptureMachine` owns that default.
   */
  idleTimeoutMs?: number;
  /**
   * `voice.bargeIn.satellite`, in the shape `EnergyVad` takes.
   *
   * Absent when the operator tuned nothing — the VAD owns its own defaults, so
   * an untuned host behaves exactly as it did before this field existed. Only
   * the two fields the detector HAS are carried: `silenceMs` has no counterpart
   * here, because `CaptureMachine` ends an utterance on a count of silent
   * FRAMES and a frame is only a duration once the device says how long it is.
   */
  vadTuning?: { threshold?: number; minSpeechMs?: number };
  /** Setup failures that are not probes: no config, bad `--url`, unknown `--device`. */
  errors: string[];
  /** Config deprecations, surfaced before anything else runs. */
  deprecations: string[];
}

export interface ListenStartOptions {
  /** Fired once the daemon is fully up, before the keep-alive. Test seam. */
  onReady?: () => void;
  /**
   * Transport for the satellite client. Test seam — production leaves it unset
   * and gets the `ws` socket. Supplying it also skips the auth-cookie lookup:
   * an injected transport is not talking to a real `/satellite/ws`, and the
   * lookup lazily pulls in the whole web-api module graph.
   */
  createSocket?: SatelliteSocketFactory;
}

// ---------------------------------------------------------------------------
// Exit codes — a sibling of `computeDoctorExit`, not a reshaping of it
// ---------------------------------------------------------------------------

/**
 * `ethos doctor`'s flag shape is about SDKs, secrets, and channel tokens; none
 * of its seven fields name a thing this preflight probes, and widening it so a
 * missing wake model could be squeezed into `configuredMissing` would make both
 * commands harder to read. So the 0/1/2 CONTRACT is reused verbatim and the
 * flags are local.
 */
export interface ListenFailFlags {
  /** A configured engine's probe failed, or its import threw. */
  engineFailed: boolean;
  /** The configured engine needs model files and they are missing or unreadable. */
  modelsMissing: boolean;
  /** Nothing to capture from right now. Recoverable: plug a pipe in. */
  micUnavailable: boolean;
  /** The server is not up. Recoverable: it reconnects with backoff. */
  serverUnreachable: boolean;
  /** No config, bad `--url`, unknown `--device`. */
  setupError: boolean;
}

/**
 * Hard failures (1) are the ones a human must fix on this machine before the
 * satellite can ever work: a wake stack that will not load, a model that is not
 * there, a command line that does not resolve. The warn code (2) is for the two
 * conditions that are TRUE RIGHT NOW and may not be in a minute — no pipe
 * attached yet, server not started yet — because a CI check must tell "this
 * host will never hear you" from "nothing is talking to it at the moment".
 */
export function computeListenExit(f: ListenFailFlags): number {
  if (f.setupError || f.engineFailed || f.modelsMissing) return 1;
  if (f.micUnavailable || f.serverUnreachable) return WARN_EXIT;
  return 0;
}

export function deriveListenFailFlags(pre: ListenPreflight): ListenFailFlags {
  const failed = (name: string): boolean =>
    pre.probes.some((p) => p.name === name && !p.ok && p.skipped !== true);
  return {
    engineFailed: pre.probes.some(
      (p) => p.name.startsWith('engine:') && !p.ok && p.skipped !== true,
    ),
    modelsMissing: pre.modelsRequired && failed('models'),
    micUnavailable: failed('microphone'),
    serverUnreachable: failed(LANE_PROBE_NAME),
    setupError: pre.errors.length > 0,
  };
}

/** Is this probe row a hard failure, given what the host will actually run? */
export function isFatalRow(row: DoctorProbeRow, pre: ListenPreflight): boolean {
  if (row.ok || row.skipped === true) return false;
  if (row.name === 'models') return pre.modelsRequired;
  return row.name.startsWith('engine:');
}

// ---------------------------------------------------------------------------
// URL derivation
// ---------------------------------------------------------------------------

export interface ListenUrls {
  socket: string;
  health: string;
}

/**
 * Where the satellite lane lives, from the operator's own base URL.
 *
 * An `--url` override is taken as given except for a bare origin, which gets
 * the lane path appended: pasting `ws://pi.local:3000` and getting a silent
 * connection failure at `/` teaches nothing.
 */
export function deriveListenUrls(webBaseUrl: string | undefined, override?: string): ListenUrls {
  const base = override ?? webBaseUrl ?? `http://127.0.0.1:${DEFAULT_WEB_PORT}`;
  const parsed = new URL(base);
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  const path =
    parsed.pathname === '' || parsed.pathname === '/' ? SATELLITE_SOCKET_PATH : parsed.pathname;
  const socket = `${secure ? 'wss:' : 'ws:'}//${parsed.host}${path}`;
  const health = `${secure ? 'https:' : 'http:'}//${parsed.host}/healthz`;
  return { socket, health };
}

// ---------------------------------------------------------------------------
// Node id
// ---------------------------------------------------------------------------

/**
 * The satellite's stable identity, generated once and then read forever.
 *
 * A PER-BOOT RANDOM ID WOULD FORK THE CONVERSATION EVERY RESTART. The server's
 * lane key is `voice:<node>:<personality>`, so a new id on every start means a
 * new lane: the kitchen Pi comes back from a power cut as a different node,
 * and the conversation it was having is orphaned in the store under a key
 * nothing will ever ask for again.
 *
 * The COMPOSED id is what is persisted, not the uuid alone. The hostname is in
 * there so the Settings → Voice row is legible ("pi-kitchen-1a2b3c4d" rather
 * than a bare uuid), but reading the hostname again on every boot would hand
 * the same fork back the moment somebody renames the machine.
 */
export async function resolveListenNodeId(
  storage: Storage,
  path: string,
  generate: () => string = defaultNodeId,
): Promise<string> {
  const existing = (await storage.read(path))?.trim();
  if (existing) return existing;
  const id = generate();
  // The file's OWN parent, not `ethosDir()`: the path is a parameter so tests
  // (and a relocated data dir) write where they were told to.
  await storage.mkdir(dirname(path));
  await storage.writeAtomic(path, `${id}\n`);
  return id;
}

function defaultNodeId(): string {
  const host = hostname()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = randomUUID().slice(0, 8);
  return host.length > 0 ? `${host}-${suffix}` : `satellite-${suffix}`;
}
