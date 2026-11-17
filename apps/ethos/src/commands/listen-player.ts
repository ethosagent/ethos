// `ethos listen` — audio OUT: the player this host spawns and the playback
// device that writes a reply's audio into it. Split out of listen.ts.

import { spawn } from 'node:child_process';
import { EthosError } from '@ethosagent/types';
import type { AudioDeviceInfo, PlaybackDevice, PlaybackFormat } from '@ethosagent/voice-satellite';
import { isOnPath } from './_shared';

// ---------------------------------------------------------------------------
// Audio OUT — the loudspeaker this host used to declare it did not have
// ---------------------------------------------------------------------------

/**
 * Which player this host will spawn.
 *
 * `custom` is an operator's own `--play` template, run through `sh -c` so their
 * quoting and pipelines survive (the same contract `command-tts` gives its
 * template). The other three are argv this file builds itself, which is what
 * lets it vary the flags by codec — see {@link playerArgv}.
 */
export type PlayerKind = 'ffplay' | 'aplay' | 'play' | 'custom';

export interface PlayerReport {
  kind: PlayerKind;
  /** The command as the operator sees it, `{rate}` / `{channels}` intact. */
  command: string;
}

export interface PlayerResolution {
  /** What will be spawned, or null when this host cannot make a sound. */
  player: PlayerReport | null;
  /**
   * Which player was found, or the REAL reason there is none. Never empty —
   * "no output device" was the old answer and it taught an operator nothing
   * about which command to install.
   */
  detail: string;
}

/**
 * PATH probe order, and the command each one gets.
 *
 * `ffplay` first because it is the only one of the three that can play what the
 * server usually sends: every first-party TTS provider except a `pcm`-mode
 * `command-tts` synthesizes opus or mp3, which reaches this node as
 * `codec: 'encoded'` and needs a demuxer. `aplay` and `play` take raw samples
 * only — they are still worth probing (a deployment wired to local PCM has
 * them and not ffmpeg), but a node holding one of them refuses an encoded
 * playout rather than blasting an ogg header at a speaker.
 */
const PLAYER_PROBES: ReadonlyArray<{ kind: Exclude<PlayerKind, 'custom'>; command: string }> = [
  {
    kind: 'ffplay',
    command: 'ffplay -nodisp -autoexit -loglevel error -f s16le -ar {rate} -ac {channels} -i -',
  },
  { kind: 'aplay', command: 'aplay -q -f S16_LE -r {rate} -c {channels} -t raw' },
  { kind: 'play', command: 'play -q -t raw -r {rate} -e signed -b 16 -c {channels} -' },
];

/**
 * Decide how this host will make a sound — by ASKING, never by assuming.
 *
 * The flag wins and is taken at face value: an operator who typed a command
 * knows their machine better than a probe does, and second-guessing it would
 * mean refusing to start a player that works. Absent the flag, PATH is probed
 * in {@link PLAYER_PROBES} order and the first hit is used; finding nothing
 * returns a null player and the sentence that says which three commands were
 * looked for, because "install one of these" is the actionable half.
 */
export function resolvePlayer(
  flag: string | undefined,
  onPath: (bin: string) => boolean = isOnPath,
): PlayerResolution {
  const requested = flag?.trim();
  if (requested !== undefined && requested !== '') {
    return {
      player: { kind: 'custom', command: requested },
      detail: `--play: ${requested} (run through \`sh -c\`; reply audio is written to its stdin)`,
    };
  }
  for (const candidate of PLAYER_PROBES) {
    if (!onPath(candidate.kind)) continue;
    return {
      player: { kind: candidate.kind, command: candidate.command },
      detail:
        `${candidate.kind} on PATH — ${candidate.command}` +
        (candidate.kind === 'ffplay'
          ? ''
          : `. Raw PCM only: an encoded reply (opus/mp3, what most TTS providers ` +
            `synthesize) cannot be played by this command. Install ffmpeg for ffplay, or set ` +
            `auxiliary.tts.outputFormat: pcm`),
    };
  }
  return {
    player: null,
    detail:
      'none of ffplay, aplay or play is on PATH, so nothing here can make a sound — ' +
      'wake turns answer as TEXT ONLY (the ‹ line). Install ffmpeg (for ffplay), ' +
      'alsa-utils (aplay) or sox (play), or name your own with --play "<command>".',
  };
}

/**
 * The argv for one playout, or the refusal that names what this player cannot open.
 *
 * A REFUSAL IS NOT A FAILURE TO REPORT LATER. `aplay` handed an ogg stream does
 * not error — it plays the container bytes as samples, which is a burst of
 * noise in somebody's kitchen at whatever hour the agent answered. So the
 * codec is checked before a process is spawned and the turn degrades to text
 * with a sentence saying which of the two ends to change.
 */
export function playerArgv(
  player: PlayerReport,
  format: PlaybackFormat,
): { argv: string[]; refusal?: undefined } | { argv?: undefined; refusal: string } {
  const rate = String(format.sampleRate);
  const channels = String(format.channels);
  const substitute = (template: string): string =>
    template.replace(/\{rate\}/g, rate).replace(/\{channels\}/g, channels);

  if (player.kind === 'custom') {
    // `sh -c` rather than a hand-rolled tokenizer: the operator's template may
    // hold quoting, a pipeline, or an environment variable, and the same
    // contract already governs `command-tts`.
    return { argv: ['sh', '-c', substitute(player.command)] };
  }
  if (player.kind === 'ffplay') {
    // Raw needs the format spelled out (PCM carries no header); encoded carries
    // its own and ffplay's demuxer must be left to find it.
    return {
      argv:
        format.codec === 'pcm_s16le'
          ? [
              'ffplay',
              '-nodisp',
              '-autoexit',
              '-loglevel',
              'error',
              '-f',
              's16le',
              '-ar',
              rate,
              '-ac',
              channels,
              '-i',
              '-',
            ]
          : ['ffplay', '-nodisp', '-autoexit', '-loglevel', 'error', '-i', '-'],
    };
  }
  if (format.codec !== 'pcm_s16le') {
    return {
      refusal:
        `${player.kind} plays RAW PCM only and the server sent ${format.mimeType} — ` +
        'playing the container bytes as samples would be noise, so this reply stays text.',
    };
  }
  return {
    argv:
      player.kind === 'aplay'
        ? ['aplay', '-q', '-f', 'S16_LE', '-r', rate, '-c', channels, '-t', 'raw']
        : ['play', '-q', '-t', 'raw', '-r', rate, '-e', 'signed', '-b', '16', '-c', channels, '-'],
  };
}

/**
 * The slice of a spawned player this device uses.
 *
 * Narrow on purpose: a test drives a fake with three methods and no process,
 * and the device's staleness discipline is then testable without a sound card.
 */
export interface PlayerProcess {
  /** Feed the player. Must not throw — a player that died is a `end()` problem. */
  write(chunk: Uint8Array): void;
  /** Close stdin and resolve once the process has actually exited. */
  end(): Promise<void>;
  /** Kill it now, mid-sentence. */
  kill(): void;
}

/**
 * Spawn one player and wrap it.
 *
 * `end()` waits for EXIT, not for the write to flush, and that is the whole
 * point of this device: a player's stdin drains in milliseconds while the sound
 * it describes takes seconds to leave the speaker. Only the process ending says
 * the room went quiet — which is what `playback_done` claims and what the
 * microphone's re-arm depends on.
 */
function spawnPlayerProcess(argv: string[]): PlayerProcess {
  const [bin, ...args] = argv;
  const child = spawn(bin ?? '', args, { stdio: ['pipe', 'ignore', 'ignore'] });
  let failure: Error | null = null;
  let exited = false;
  child.once('error', (err: Error) => {
    failure = err;
    exited = true;
  });
  child.once('close', () => {
    exited = true;
  });
  // A player that exits early (a wrong format, a busy sound card) turns the
  // next write into an EPIPE the host has no way to handle. Swallowed here and
  // surfaced by `end()`, which is the one place a playout failure can still be
  // narrated without dropping the re-arm.
  child.stdin?.on('error', (err: Error) => {
    failure ??= err;
  });
  return {
    write(chunk: Uint8Array): void {
      if (exited) return;
      child.stdin?.write(chunk);
    },
    async end(): Promise<void> {
      child.stdin?.end();
      if (!exited) {
        await new Promise<void>((resolve) => {
          child.once('close', () => resolve());
          child.once('error', () => resolve());
        });
      }
      const err = failure;
      if (err !== null) throw err;
    },
    kill(): void {
      if (exited) return;
      child.kill();
    },
  };
}

export interface CommandPlaybackDeviceOptions {
  player: PlayerReport;
  /** Injected so tests drive a fake process. Production leaves it unset. */
  spawnPlayer?: (argv: string[]) => PlayerProcess;
}

/**
 * A `PlaybackDevice` that is one spawned command per utterance.
 *
 * ONE PROCESS PER UTTERANCE, not one long-lived player. A player fed a
 * continuous stream has no way to say "this utterance finished" — its stdin
 * never closes, so nothing ever reports the speaker draining and the re-arm
 * would be back to guessing. Exiting at EOF is the receipt.
 *
 * Every method checks the utterance id first. Audio for anything but the
 * playout in flight is DROPPED: by the time a stale chunk arrives the room has
 * moved on, and playing it would answer a question nobody is still asking.
 */
export function createCommandPlaybackDevice(opts: CommandPlaybackDeviceOptions): PlaybackDevice {
  const spawnPlayer = opts.spawnPlayer ?? spawnPlayerProcess;
  let active: { utteranceId: string; proc: PlayerProcess } | null = null;

  return {
    async start(utteranceId: string, format: PlaybackFormat): Promise<void> {
      // A playout still running here means the lane moved on without a
      // `turn_end`; killing it is cheaper than two players over one sound card.
      const previous = active;
      active = null;
      previous?.proc.kill();
      const built = playerArgv(opts.player, format);
      if (built.refusal !== undefined) {
        throw new EthosError({
          code: 'CONFIG_INVALID',
          cause: built.refusal,
          action:
            'Install ffmpeg — its ffplay demuxes opus and mp3 — or set ' +
            'auxiliary.tts.outputFormat: pcm so the server synthesizes raw samples, ' +
            'or name a player that can with `ethos listen --play "<command>"`.',
        });
      }
      active = { utteranceId, proc: spawnPlayer(built.argv) };
    },

    write(utteranceId: string, pcm: Uint8Array): void {
      const current = active;
      if (current === null || current.utteranceId !== utteranceId) return;
      current.proc.write(pcm);
    },

    async end(utteranceId: string): Promise<void> {
      const current = active;
      if (current === null || current.utteranceId !== utteranceId) return;
      active = null;
      await current.proc.end();
    },

    cancel(utteranceId: string): void {
      const current = active;
      if (current === null || current.utteranceId !== utteranceId) return;
      active = null;
      current.proc.kill();
    },

    async list(): Promise<AudioDeviceInfo[]> {
      return [{ id: opts.player.kind, label: opts.player.command, isDefault: true }];
    },
  };
}
