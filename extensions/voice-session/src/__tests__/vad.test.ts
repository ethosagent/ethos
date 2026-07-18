import { describe, expect, it } from 'vitest';
import { EnergyVad, rmsEnergy } from '../vad';
import { silenceFrame, speechFrame } from './fakes';

describe('rmsEnergy', () => {
  it('is zero for silence and positive for a loud frame', () => {
    expect(rmsEnergy(silenceFrame().data)).toBe(0);
    expect(rmsEnergy(speechFrame().data)).toBeGreaterThan(0.02);
  });
});

describe('EnergyVad', () => {
  it('classifies a loud frame as speech and a silent frame as not', () => {
    const vad = new EnergyVad({ threshold: 0.02, hangoverFrames: 0 });
    expect(vad.process(speechFrame()).speech).toBe(true);
    expect(vad.process(silenceFrame()).speech).toBe(false);
  });

  it('keeps speech alive for the hangover window', () => {
    const vad = new EnergyVad({ threshold: 0.02, hangoverFrames: 2 });
    expect(vad.process(speechFrame()).speech).toBe(true);
    // Two trailing silence frames stay "speech" via hangover, then drop.
    expect(vad.process(silenceFrame()).speech).toBe(true);
    expect(vad.process(silenceFrame()).speech).toBe(true);
    expect(vad.process(silenceFrame()).speech).toBe(false);
  });
});
