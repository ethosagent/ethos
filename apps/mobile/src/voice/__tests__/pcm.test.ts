import { describe, expect, it } from 'vitest';
import {
  createFramer,
  createResampler,
  FRAME_MS,
  floatToInt16,
  frameSamples,
  levelFromRms,
  PIPELINE_SAMPLE_RATE,
  resampleClip,
  resampledLength,
} from '../pcm';

const ramp = (n: number): Float32Array => Float32Array.from({ length: n }, (_, i) => i / n);

/** Push `input` in chunks of the given sizes and join the output. */
function pushChunked(from: number, to: number, input: Float32Array, sizes: number[]): number[] {
  const resampler = createResampler(from, to);
  const out: number[] = [];
  let offset = 0;
  let i = 0;
  while (offset < input.length) {
    const size = sizes[i++ % sizes.length] ?? 1;
    out.push(...resampler.push(input.subarray(offset, offset + size)));
    offset += size;
  }
  return out;
}

describe('floatToInt16', () => {
  it('scales asymmetrically and clamps out-of-range samples', () => {
    expect([...floatToInt16(Float32Array.from([0, 1, -1, 0.5, 2, -2]))]).toEqual([
      0, 32767, -32768, 16383, 32767, -32768,
    ]);
  });
});

describe('frameSamples', () => {
  it('is 20 ms of samples at the lane rate', () => {
    expect(FRAME_MS).toBe(20);
    expect(frameSamples(PIPELINE_SAMPLE_RATE)).toBe(320);
    expect(frameSamples(24_000)).toBe(480);
  });
});

describe('createResampler', () => {
  it('passes the same rate through untouched', () => {
    const input = ramp(10);
    expect(createResampler(16_000, 16_000).push(input)).toBe(input);
  });

  it('48 kHz → 16 kHz averages each run of three samples', () => {
    const out = createResampler(48_000, 16_000).push(Float32Array.from([1, 2, 3, 4, 5, 6, 7]));
    // The seventh sample opens a span that is not complete yet.
    expect([...out]).toEqual([2, 5]);
  });

  it('44.1 kHz → 16 kHz keeps the long-run rate exact, whatever the chunking', () => {
    const second = ramp(44_100);
    const whole = pushChunked(44_100, 16_000, second, [44_100]);
    const chunked = pushChunked(44_100, 16_000, second, [441, 17, 1024, 3]);
    expect(chunked).toEqual(whole);
    // One output is held back until its span is complete.
    expect(whole.length).toBeGreaterThanOrEqual(15_999);
    expect(whole.length).toBeLessThanOrEqual(16_000);
  });

  it('8 kHz → 16 kHz interpolates between samples, across chunk boundaries', () => {
    const whole = pushChunked(8_000, 16_000, Float32Array.from([0, 1, 0, -1]), [4]);
    const chunked = pushChunked(8_000, 16_000, Float32Array.from([0, 1, 0, -1]), [1]);
    expect(whole).toEqual([0, 0.5, 1, 0.5, 0, -0.5, -1]);
    expect(chunked).toEqual(whole);
  });

  it('16 kHz → 24 kHz (a realtime provider rate) produces 1.5× the samples', () => {
    const out = pushChunked(16_000, 24_000, ramp(16_000), [160]);
    expect(Math.abs(out.length - 24_000)).toBeLessThanOrEqual(1);
  });
});

describe('createFramer', () => {
  it('emits fixed frames and holds the remainder for the next push', () => {
    const framer = createFramer(4);
    const first = framer.push(Int16Array.from([1, 2, 3, 4, 5, 6]));
    expect(first.map((f) => [...f])).toEqual([[1, 2, 3, 4]]);
    const second = framer.push(Int16Array.from([7, 8, 9]));
    expect(second.map((f) => [...f])).toEqual([[5, 6, 7, 8]]);
  });

  it('reset drops the partial frame', () => {
    const framer = createFramer(4);
    framer.push(Int16Array.from([1, 2, 3]));
    framer.reset();
    expect(framer.push(Int16Array.from([4, 5, 6, 7])).map((f) => [...f])).toEqual([[4, 5, 6, 7]]);
  });
});

describe('levelFromRms', () => {
  it('scales speech RMS into 0..1 and clamps', () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(0.1)).toBeCloseTo(0.4);
    expect(levelFromRms(0.9)).toBe(1);
  });
});

describe('resampleClip', () => {
  it('is the identity at equal rates', () => {
    const input = ramp(10);
    expect(resampleClip(input, 24_000, 24_000)).toBe(input);
  });

  it('upsamples 24 → 48 kHz linearly, keeping the duration', () => {
    const out = resampleClip(Float32Array.from([0, 1, 0, -1]), 24_000, 48_000);
    expect(out).toHaveLength(resampledLength(4, 24_000, 48_000));
    expect([...out]).toEqual([0, 0.5, 1, 0.5, 0, -0.5, -1, -1]);
  });

  it('upsamples to a non-integer ratio without running off the end', () => {
    const out = resampleClip(ramp(2_400), 24_000, 44_100);
    expect(out).toHaveLength(4_410);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBeCloseTo(2_399 / 2_400, 6);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1] ?? 0);
  });

  it('downsamples by averaging each span', () => {
    const out = resampleClip(Float32Array.from([1, 3, 5, 7, 9, 11]), 48_000, 16_000);
    expect([...out]).toEqual([3, 9]);
  });

  it('never yields an empty clip', () => {
    expect(resampledLength(1, 48_000, 8_000)).toBe(1);
    expect(resampleClip(Float32Array.from([0.25]), 48_000, 8_000)).toHaveLength(1);
  });
});
