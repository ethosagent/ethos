// Every dotted Claude id in the model catalog (OpenRouter spells versions with
// a dot: `anthropic/claude-opus-5.5`) must price at the row its dashed spelling
// reaches. `findRate` normalises the dot (packages/pricing/src/table.ts); this
// pins it against the ids users can actually pick.

import { findRate } from '@ethosagent/pricing';
import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG } from '../model-catalog';

describe('dotted Claude ids in MODEL_CATALOG', () => {
  const dotted = MODEL_CATALOG.map((m) => m.modelId).filter((id) =>
    /claude-[a-z0-9-]*\d\.\d/.test(id),
  );

  it('the catalog carries at least one', () => {
    expect(dotted.length).toBeGreaterThan(0);
  });

  it('each prices at the same row as its dashed twin', () => {
    for (const id of dotted) {
      const dashed = id.replace(/(\d)\.(\d)/g, '$1-$2');
      expect(findRate(dashed), dashed).toBeDefined();
      expect(findRate(id)?.prefix, id).toBe(findRate(dashed)?.prefix);
    }
  });
});
