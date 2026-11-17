// `ethos listen` — edge STT: the result types, the shared audio-egress sentence and
// the capability rows that report them. Split out of listen.ts. The resolver
// itself (`resolveEdgeSttFrom`) stays in listen.ts with its `@ethosagent/core`
// import, which archcheck rule `l5-apps-through-wiring` baselines for that file
// only (`.archcheck/baseline.json`, rules in `architecture.config.ts`).

import type { SttProvider } from '@ethosagent/types';
import type { DoctorProbeRow } from '@ethosagent/voice-satellite';
import type { PlayerResolution } from './listen-player';

// ---------------------------------------------------------------------------
// Edge STT — the recognizer that keeps the room's audio on the machine
// ---------------------------------------------------------------------------

/** What `voice.wake.edgeStt` actually got, once something tried to build it. */
export interface EdgeSttResolution {
  /** The recognizer that will run HERE, or null when there is none. */
  provider: SttProvider | null;
  /** Registered provider id, whenever a name resolved — refused ones included. */
  providerId?: string;
  /** Why there is no on-device recognizer. Absent when there is one. */
  reason?: string;
}

/** The serializable half, for the doctor row and the `--json` object. */
export interface EdgeSttReport {
  /** `voice.wake.edgeStt` is set. */
  requested: boolean;
  /** A LOCAL recognizer resolved: this node transcribes and sends only words. */
  enabled: boolean;
  providerId?: string;
  /** Which recognizer resolved, or the specific reason none did. Never empty. */
  detail: string;
}

/** Said the same way wherever the audio path is described, so it cannot drift. */
export const AUDIO_GOES_UP =
  'audio WILL be streamed to the server, which transcribes it there — the ' +
  '"no audio leaves the machine" guarantee does not hold on this host.';

/**
 * How much of one utterance is held in memory for on-device transcription.
 *
 * The audio path never needed a cap — frames go out as they arrive — but the
 * edge path ACCUMULATES, and an appliance in a room full of continuous talk
 * would otherwise grow a buffer until the Pi ran out. The number is the lane's
 * own `maxUtteranceBytes`, so an utterance too long to transcribe here is
 * exactly an utterance too long to transcribe there: one limit, one behaviour,
 * whichever end is doing the work.
 */
export const EDGE_UTTERANCE_MAX_BYTES = 8 * 1024 * 1024;

/** `voice.wake.edgeStt` is off. Not a fault — just the other audio path. */
export const EDGE_STT_OFF = `voice.wake.edgeStt is off, so every utterance is transcribed by the server: ${AUDIO_GOES_UP}`;

/**
 * The two rows that say what this host can DO with a turn: make a sound, and
 * keep the audio at home.
 *
 * NEITHER MOVES THE EXIT CODE — `deriveListenFailFlags` names the rows it
 * reads, and these are not among them. A host with no loudspeaker and a host
 * whose audio is transcribed by the server are both fully working satellites;
 * they just do less than the operator may have assumed, and a preflight that
 * failed over it would be refusing to start the deployment that shipped for
 * months. The rows are where the assumption gets corrected, not where the boot
 * gets blocked.
 *
 * The `edge-stt` row is SKIPPED rather than ticked when nothing was asked for.
 * A green tick there would read as "your audio stays here", which is the
 * opposite of what an unset `voice.wake.edgeStt` means — and the doctor's rule
 * is that an unrun probe reports skipped, never passed.
 */
export function capabilityRows(player: PlayerResolution, edgeStt: EdgeSttReport): DoctorProbeRow[] {
  return [
    { name: 'speaker', ok: player.player !== null, detail: player.detail },
    edgeStt.requested
      ? { name: 'edge-stt', ok: edgeStt.enabled, detail: edgeStt.detail }
      : { name: 'edge-stt', ok: true, skipped: true, detail: `skipped — ${edgeStt.detail}` },
  ];
}

/** The resolution as the doctor and the JSON see it. */
export function edgeSttReport(requested: boolean, resolution: EdgeSttResolution): EdgeSttReport {
  if (resolution.provider !== null) {
    return {
      requested,
      enabled: true,
      ...(resolution.providerId === undefined ? {} : { providerId: resolution.providerId }),
      detail:
        `on-device: ${resolution.providerId ?? 'unnamed'} (caps.local) — this node transcribes ` +
        'the utterance itself and sends only the WORDS upstream. No captured audio leaves ' +
        'this machine.',
    };
  }
  return {
    requested,
    enabled: false,
    ...(resolution.providerId === undefined ? {} : { providerId: resolution.providerId }),
    detail: resolution.reason ?? EDGE_STT_OFF,
  };
}
