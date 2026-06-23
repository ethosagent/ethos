import { describe, expect, it } from 'vitest';

describe('LLM provider contract — drift gate', () => {
  it('CompletionChunk has exactly 8 variants', async () => {
    // The frozen CompletionChunk union must not gain or lose variants without
    // bumping this test in the same commit (ARCHITECTURE.md §VII).
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../llm.ts', import.meta.url), 'utf8'),
    );
    // Count the `| { type: '...'` lines in the CompletionChunk union.
    // The union ends at `};\n` on a line by itself (after the last variant).
    // We match until the first blank line after the union declaration.
    const chunkMatch = src.match(/export type CompletionChunk\s*=\n([\s\S]*?)\n\n/);
    expect(chunkMatch).toBeTruthy();
    const variants = (chunkMatch?.[1] ?? '').match(/\|\s*\{\s*type:\s*'/g);
    expect(variants?.length).toBe(8);
  });

  it('LLMProvider has capabilities field', async () => {
    // Verify the capabilities field exists on the contract
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../llm.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain('capabilities?: ProviderCapabilities');
  });

  it('CompletionOptions has providerOptions escape hatch', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../llm.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain('providerOptions?:');
  });
});
