import {
  VOICE_LATENCY_BUDGET_MS,
  VOICE_REALTIME_LATENCY_BUDGET_MS,
} from '@ethosagent/voice-session';
import { describe, expect, it } from 'vitest';
import { m2eBarForTier, PHONE_VOICE_BAR, PIPELINE_M2E_BUDGET_MS } from '../bar';

describe('PHONE_VOICE_BAR', () => {
  it('restates the pipeline budget from voice-session without drift', () => {
    expect(PIPELINE_M2E_BUDGET_MS).toBe(VOICE_LATENCY_BUDGET_MS.pipeline);
  });

  it('grades the realtime tier at the repo realtime budget', () => {
    expect(PHONE_VOICE_BAR.m2eMedianMs).toBe(VOICE_REALTIME_LATENCY_BUDGET_MS.pipeline);
    expect(m2eBarForTier('realtime')).toEqual({ medianMs: 800, p95Ms: 1500 });
  });

  it('grades the pipeline tier at the pipeline budget with the same p95 headroom', () => {
    expect(m2eBarForTier('pipeline')).toEqual({ medianMs: 1600, p95Ms: 2300 });
  });
});
