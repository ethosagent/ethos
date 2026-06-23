import { runConformance, validateToolCallBuffering } from '@ethosagent/wiring/conformance';
import { describe, expect, it } from 'vitest';
import { MyProvider } from '../index';

describe('MyProvider conformance', () => {
  const provider = new MyProvider({
    apiKey: 'test-key',
    model: 'test-model',
  });

  it('passes conformance checks', async () => {
    const result = await runConformance(provider);
    for (const check of result.checks) {
      if (!check.passed) {
        throw new Error(`Conformance check "${check.name}" failed: ${check.message}`);
      }
    }
    expect(result.passed).toBe(true);
  });

  it('produces valid tool-call buffering', async () => {
    // Collect chunks from a simple completion
    const chunks = [];
    for await (const chunk of provider.complete([{ role: 'user', content: 'test' }], [], {
      maxTokens: 10,
    })) {
      chunks.push(chunk);
    }
    const result = validateToolCallBuffering(chunks);
    expect(result.passed).toBe(true);
  });
});
