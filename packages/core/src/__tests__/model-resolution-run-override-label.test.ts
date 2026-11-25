import type { ModelRegistry, ModelResolutionFailure, ResolvedModel } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { resolveModel } from '../model-resolution';

const registry: ModelRegistry = {
  entries: {
    sonnet: { alias: 'sonnet', provider: 'anthropic', modelId: 'claude-sonnet-5' },
    haiku: { alias: 'haiku', provider: 'anthropic', modelId: 'claude-haiku-5' },
    qwen: { alias: 'qwen', provider: 'ollama-local', modelId: 'qwen2.5-coder:32b' },
  },
  default: 'sonnet',
  roles: {},
};
const ctx = { registry, routing: {} };
const personality = { id: 'engineer', model: 'qwen' } as const;

function expectResolved(result: ResolvedModel | ModelResolutionFailure): ResolvedModel {
  if ('ok' in result) throw new Error(`expected a resolved model, got: ${result.reason}`);
  return result;
}

describe('resolveModel — run override label', () => {
  it("a room's run override names the room's policy, not the person, and announces once", () => {
    const resolved = expectResolved(
      resolveModel({
        personality,
        role: 'default',
        ctx,
        runOverride: 'haiku',
        runOverrideLabel: "This room's policy",
      }),
    );
    expect(resolved.source).toBe('run-override');
    expect(resolved.deviation?.reason).toBe('This room\'s policy sets "haiku" for this run.');
    expect(resolved.deviation?.once).toBe(true);
  });

  it('an unlabelled run override still reads "You pinned"', () => {
    const resolved = expectResolved(
      resolveModel({ personality, role: 'default', ctx, runOverride: 'haiku' }),
    );
    expect(resolved.deviation?.reason).toBe('You pinned "haiku" for this run.');
  });
});
