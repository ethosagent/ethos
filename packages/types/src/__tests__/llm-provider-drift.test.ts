import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ARCHITECTURE = join(import.meta.dirname, '..', '..', '..', '..', 'ARCHITECTURE.md');

// The frozen CompletionChunk union, in declaration order. `compaction` was
// added by the openclaw-9.5-adoption item 7 §VI Substantive amendment (D31).
const FROZEN_VARIANTS = [
  'text_delta',
  'thinking_delta',
  'tool_use_start',
  'tool_use_delta',
  'tool_use_end',
  'usage',
  'done',
  'warning',
  'compaction',
];

function unionVariants(src: string): string[] {
  // The union ends at the first blank line after the declaration.
  const chunkMatch = src.match(/export type CompletionChunk\s*=\n([\s\S]*?)\n\n/);
  expect(chunkMatch).toBeTruthy();
  return [...(chunkMatch?.[1] ?? '').matchAll(/\|\s*\{\s*type:\s*'([a-z_]+)'/g)].map(
    (m) => m[1] ?? '',
  );
}

/** The `llm_provider:` entry from ARCHITECTURE.md's `frozen_schemas:` block. */
function readArchitectureManifest(md: string): { count: number; variants: string[] } {
  const entryIdx = md.indexOf('\n  llm_provider:');
  if (entryIdx < 0) throw new Error('frozen_schemas.llm_provider not found in ARCHITECTURE.md');
  const block = md.slice(entryIdx, entryIdx + 900);
  const count = /frozen_variant_count:\s*(\d+)/.exec(block)?.[1];
  const variants = /frozen_variants:\s*\[([^\]]*)\]/.exec(block)?.[1];
  if (count === undefined || variants === undefined) {
    throw new Error('llm_provider entry is missing frozen_variant_count / frozen_variants');
  }
  return {
    count: Number(count),
    variants: variants
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}

describe('LLM provider contract — drift gate', () => {
  it('CompletionChunk has exactly 9 variants', async () => {
    // The frozen CompletionChunk union must not gain or lose variants without
    // bumping this test in the same commit (ARCHITECTURE.md §VII).
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../llm.ts', import.meta.url), 'utf8'),
    );
    const variants = unionVariants(src);
    expect(variants.length).toBe(9);
    expect(variants).toEqual(FROZEN_VARIANTS);
  });

  it('matches the ARCHITECTURE.md §VII frozen_schemas manifest', () => {
    const manifest = readArchitectureManifest(readFileSync(ARCHITECTURE, 'utf-8'));
    expect(manifest.variants).toEqual(FROZEN_VARIANTS);
    expect(manifest.count).toBe(FROZEN_VARIANTS.length);
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
