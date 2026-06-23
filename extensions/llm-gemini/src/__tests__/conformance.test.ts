import { runConformance } from '@ethosagent/wiring/conformance';
import { describe, expect, it } from 'vitest';
import { GeminiNativeProvider } from '../index';

describe('GeminiNativeProvider conformance', () => {
  const provider = new GeminiNativeProvider({
    apiKey: 'test-key',
    model: 'gemini-2.5-flash',
  });

  it('passes conformance checks', async () => {
    const result = await runConformance(provider);
    for (const check of result.checks) {
      if (!check.passed && !check.message?.includes('Skipped')) {
        throw new Error(`Conformance check "${check.name}" failed: ${check.message}`);
      }
    }
  });

  it('declares capabilities', () => {
    expect(provider.capabilities).toBeDefined();
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.toolCalling).toBe(true);
    expect(provider.capabilities.visionImages).toBe(true);
    expect(provider.capabilities.contractVersion).toBe(1);
  });

  it('implements LLMProvider interface', () => {
    expect(provider.name).toBe('gemini-native');
    expect(provider.model).toBe('gemini-2.5-flash');
    expect(provider.maxContextTokens).toBe(1_000_000);
    expect(provider.supportsCaching).toBe(false);
    expect(provider.supportsThinking).toBe(false);
    expect(typeof provider.complete).toBe('function');
    expect(typeof provider.countTokens).toBe('function');
  });
});
