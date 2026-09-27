// The capture path's pure arithmetic: float → PCM16, rate conversion, fixed
// framing. The recorder hands over float32 chunks at whatever rate and length
// the hardware settled on; the voice lane wants mono PCM16 in fixed 20 ms
// frames at ONE declared rate (the `hello` frame's `sampleRate`, or the
// realtime provider's `inputSampleRate`). Everything between the two is here,
// with no audio library in sight, so it is tested in node.

/** One frame's duration. 20 ms is the realtime providers' native cadence and
 *  small enough that local barge-in's 100 ms sustain is five frames. */
export const FRAME_MS = 20;

/** The pipeline tier's capture rate: what streaming STT is built around, and a
 *  third of the bytes of the web's 48 kHz. The server takes any rate `hello`
 *  declares (`voice-lane.ts`), so this is a bandwidth choice, not a contract. */
export const PIPELINE_SAMPLE_RATE = 16_000;

export function frameSamples(sampleRate: number, frameMs = FRAME_MS): number {
  return Math.round((sampleRate * frameMs) / 1000);
}

/** Clamp to [-1, 1] and scale asymmetrically, as the web capture does. */
export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}

/** Streaming rate converter. `push` may be called with chunks of any length;
 *  the output is the same as converting the concatenation in one go. */
export interface Resampler {
  readonly fromRate: number;
  readonly toRate: number;
  push(input: Float32Array): Float32Array;
}

/**
 * Downsampling averages every input sample that falls in an output sample's
 * span (a box filter — the cheapest low-pass that keeps 48 kHz room noise from
 * folding into the speech band); upsampling interpolates linearly. Both carry
 * their position across calls as an exact input-sample count, so a long call
 * does not drift.
 */
export function createResampler(fromRate: number, toRate: number): Resampler {
  if (fromRate === toRate) {
    return { fromRate, toRate, push: (input) => input };
  }
  return fromRate > toRate
    ? createDownsampler(fromRate, toRate)
    : createUpsampler(fromRate, toRate);
}

function createDownsampler(fromRate: number, toRate: number): Resampler {
  // Output k covers input samples [ceil(k·r), ceil((k+1)·r)), r = from/to.
  // Counted in integers (input index × toRate against k × fromRate) so there
  // is no floating-point accumulation over an hour of audio.
  let inputIndex = 0;
  let outputIndex = 0;
  let sum = 0;
  let count = 0;
  return {
    fromRate,
    toRate,
    push(input) {
      const out: number[] = [];
      for (let i = 0; i < input.length; i++) {
        // Does this sample belong to the NEXT output span? It does once
        // inputIndex ≥ (outputIndex + 1) · r.
        if (count > 0 && inputIndex * toRate >= (outputIndex + 1) * fromRate) {
          out.push(sum / count);
          outputIndex++;
          sum = 0;
          count = 0;
        }
        sum += input[i] ?? 0;
        count++;
        inputIndex++;
      }
      return Float32Array.from(out);
    },
  };
}

function createUpsampler(fromRate: number, toRate: number): Resampler {
  // Output k sits at input position k · from/to. It needs the two input
  // samples around it, so the last sample of each chunk is carried over.
  let outputIndex = 0;
  /** Absolute index of `prev`; -1 before the first sample. */
  let prevIndex = -1;
  let prev = 0;
  return {
    fromRate,
    toRate,
    push(input) {
      const out: number[] = [];
      for (let i = 0; i < input.length; i++) {
        const cur = input[i] ?? 0;
        const curIndex = prevIndex + 1;
        if (prevIndex < 0) {
          // The very first sample: output 0 sits exactly on it.
          out.push(cur);
          outputIndex = 1;
          prev = cur;
          prevIndex = 0;
          continue;
        }
        // Emit every output position in (prevIndex, curIndex].
        while (outputIndex * fromRate <= curIndex * toRate) {
          const pos = (outputIndex * fromRate) / toRate - prevIndex;
          out.push(prev + (cur - prev) * pos);
          outputIndex++;
        }
        prev = cur;
        prevIndex = curIndex;
      }
      return Float32Array.from(out);
    },
  };
}

/** Cuts a PCM16 stream into fixed-length frames, holding the remainder. */
export interface Framer {
  push(samples: Int16Array): Int16Array[];
  /** Drop any partial frame (mute, interruption, restart). */
  reset(): void;
}

export function createFramer(size: number): Framer {
  let pending = new Int16Array(0);
  return {
    push(samples) {
      const joined = new Int16Array(pending.length + samples.length);
      joined.set(pending, 0);
      joined.set(samples, pending.length);
      const frames: Int16Array[] = [];
      let offset = 0;
      while (joined.length - offset >= size) {
        frames.push(joined.slice(offset, offset + size));
        offset += size;
      }
      pending = joined.slice(offset);
      return frames;
    },
    reset() {
      pending = new Int16Array(0);
    },
  };
}

/** Mic level for the meter, 0..1, from a frame's RMS. Speech RMS sits around
 *  0.02–0.25, so it is scaled up before clamping — the same envelope the web
 *  meter draws from its analyser. */
export function levelFromRms(rms: number): number {
  return Math.min(1, rms * 4);
}

/** How many samples a whole clip of `frames` at `fromRate` becomes at `toRate`.
 *  Never zero, so a buffer can always be created for a non-empty clip. */
export function resampledLength(frames: number, fromRate: number, toRate: number): number {
  return Math.max(1, Math.round((frames * toRate) / fromRate));
}

/**
 * Convert one complete clip in one go, to exactly `resampledLength` samples.
 *
 * Playout needs this because react-native-audio-api 0.13.6 does NOT resample a
 * buffer to its context's rate: `AudioBufferSourceNode` reads one buffer frame
 * per output frame, times `playbackRate`, whatever `buffer.sampleRate` says
 * (common/cpp/audioapi/core/sources/AudioBufferSourceNode.cpp
 * `runBufferProcessor`, core/utils/buffer/SingleBufferProcessor.cpp). A 24 kHz
 * TTS clip in a 48 kHz context would play at double speed and end halfway
 * through its scheduled slot. The browser resamples; the phone must do it here.
 *
 * Upsampling interpolates linearly; downsampling (a Bluetooth HFP route can put
 * the context at 16 kHz) averages each output sample's span, as the capture
 * converter does. Unlike `createResampler` it holds nothing back: a clip is
 * scheduled as a whole, so its tail is emitted, not carried.
 */
export function resampleClip(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const n = input.length;
  const length = resampledLength(n, fromRate, toRate);
  const out = new Float32Array(length);
  const ratio = fromRate / toRate;
  if (fromRate < toRate) {
    for (let k = 0; k < length; k++) {
      const pos = k * ratio;
      const i = Math.min(Math.floor(pos), n - 1);
      const a = input[i] ?? 0;
      const b = input[Math.min(i + 1, n - 1)] ?? a;
      out[k] = a + (b - a) * (pos - i);
    }
    return out;
  }
  for (let k = 0; k < length; k++) {
    const start = Math.min(Math.ceil(k * ratio), n - 1);
    const end = Math.min(Math.max(start + 1, Math.ceil((k + 1) * ratio)), n);
    let sum = 0;
    for (let i = start; i < end; i++) sum += input[i] ?? 0;
    out[k] = sum / (end - start);
  }
  return out;
}
