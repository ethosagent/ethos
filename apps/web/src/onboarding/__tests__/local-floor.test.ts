import type { KeylessCandidate } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { belowFloorText } from '../local-floor';

type Local = Extract<KeylessCandidate, { kind: 'local' }>;
const base: Local = {
  kind: 'local',
  runtime: 'ollama',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  models: ['llama3.2'],
};

describe('belowFloorText', () => {
  it('is null when the candidate is usable', () => {
    expect(belowFloorText({ ...base, contextWindow: 32000 })).toBeNull();
  });
  it('states served vs required and the Ollama remediation', () => {
    const t = belowFloorText({
      ...base,
      contextWindow: 8192,
      belowContextFloor: { servedTokens: 8192, floorTokens: 16000 },
    });
    expect(t).toMatch(/8192 tokens/);
    expect(t).toMatch(/needs 16000/);
    expect(t).toMatch(/Restart Ollama/);
  });
  it('names the generic knobs for other runtimes', () => {
    const t = belowFloorText({
      ...base,
      runtime: 'vllm',
      provider: 'vllm',
      belowContextFloor: { servedTokens: 4096, floorTokens: 16000 },
    });
    expect(t).toMatch(/--max-model-len/);
    expect(t).not.toMatch(/Ollama/);
  });
});
