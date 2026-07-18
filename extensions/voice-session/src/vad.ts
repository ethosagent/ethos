// Energy-based voice-activity detection. Deterministic and unit-testable with
// synthetic PCM.

import type { PcmChunk } from '@ethosagent/types';
import type { Vad } from './types';

/** Normalized RMS energy (0..1) of a frame of signed 16-bit PCM samples. */
export function rmsEnergy(data: Int16Array): number {
  if (data.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const s = (data[i] ?? 0) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / data.length);
}

export interface EnergyVadConfig {
  /** RMS energy threshold above which a frame counts as speech. Default 0.02. */
  threshold?: number;
  /**
   * Frames of trailing speech kept alive after energy drops below threshold —
   * smooths over brief intra-word silences. Default 3.
   */
  hangoverFrames?: number;
}

export class EnergyVad implements Vad {
  private readonly threshold: number;
  private readonly hangoverFrames: number;
  private hangover = 0;

  constructor(config: EnergyVadConfig = {}) {
    this.threshold = config.threshold ?? 0.02;
    this.hangoverFrames = config.hangoverFrames ?? 3;
  }

  process(chunk: PcmChunk): { speech: boolean } {
    if (rmsEnergy(chunk.data) >= this.threshold) {
      this.hangover = this.hangoverFrames;
      return { speech: true };
    }
    if (this.hangover > 0) {
      this.hangover--;
      return { speech: true };
    }
    return { speech: false };
  }
}
