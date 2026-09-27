import { describe, expect, it } from 'vitest';
import {
  realtimeDegradeNotice,
  shouldTryRealtime,
  streamingTalkModeSupported,
  type TalkModeEnvironment,
} from '../tier';

const full: TalkModeEnvironment = {
  hasWebSocket: true,
  hasAudioContext: true,
  hasMediaDevices: true,
  hasScriptProcessor: true,
};

describe('tier choice', () => {
  it('tries realtime only when it can mint, nothing forces the pipeline, and the host can stream', () => {
    expect(shouldTryRealtime({ canMint: true }, full)).toBe(true);
    expect(shouldTryRealtime({ canMint: false }, full)).toBe(false);
    expect(shouldTryRealtime({ canMint: true, forcePipeline: true }, full)).toBe(false);
    expect(shouldTryRealtime({ canMint: true, forceBatch: true }, full)).toBe(false);
    const noSocket = { ...full, hasWebSocket: false };
    expect(streamingTalkModeSupported(noSocket)).toBe(false);
    expect(shouldTryRealtime({ canMint: true }, noSocket)).toBe(false);
  });

  it('tells the user about a refusal but not about a configured pipeline', () => {
    const refused = {
      ok: false as const,
      reason: 'provider_refused',
      message: 'No.',
      providerId: 'x',
    };
    expect(realtimeDegradeNotice(refused)).toBe('No.');
    expect(realtimeDegradeNotice({ ...refused, reason: 'pipeline_preferred' })).toBeNull();
    expect(realtimeDegradeNotice({ ...refused, reason: 'not_configured' })).toBeNull();
  });
});
