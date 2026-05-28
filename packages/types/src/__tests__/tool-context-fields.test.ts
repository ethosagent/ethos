import { describe, expect, it } from 'vitest';

describe('ToolContext shape', () => {
  it('has llm field in the type definition', () => {
    // Compile-time assertion: if llm is removed from ToolContext, this file
    // will fail to typecheck. The runtime assertion is a placeholder.
    type AssertHasLlm = import('../tool').ToolContext extends { llm?: unknown } ? true : never;
    const _check: AssertHasLlm = true;
    expect(_check).toBe(true);
  });
});
