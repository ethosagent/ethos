import { describe, expect, it } from 'vitest';
import { KEYLESS_MODEL_IDS, pickKeylessModel } from '../keyless-models';
import { MODEL_CATALOG } from '../model-catalog';

const GIB = 1024 ** 3;

describe('keyless model pick', () => {
  it('every tier id is an ollama row in MODEL_CATALOG', () => {
    for (const id of KEYLESS_MODEL_IDS) {
      expect(
        MODEL_CATALOG.some((m) => m.providerId === 'ollama' && m.modelId === id),
        id,
      ).toBe(true);
    }
  });

  it.each([
    [8, 'llama3.2'],
    [11.99, 'llama3.2'],
    [12, 'qwen3'],
    [16, 'qwen3'],
    [24, 'gpt-oss:20b'],
    [47.9, 'gpt-oss:20b'],
    [48, 'qwen3.8:27b'],
    [64, 'qwen3.8:27b'],
  ])('%s GiB picks %s', (gib, id) => {
    expect(pickKeylessModel(gib * GIB).modelId).toBe(id);
  });

  it('returns a download hint and a reason', () => {
    const pick = pickKeylessModel(16 * GIB);
    expect(pick.approxDownloadGb).toBeGreaterThan(0);
    expect(pick.reason.length).toBeGreaterThan(0);
  });

  it('degrades to the smallest tier for a nonsensical memory value', () => {
    expect(pickKeylessModel(Number.NaN).modelId).toBe('llama3.2');
    expect(pickKeylessModel(0).modelId).toBe('llama3.2');
  });
});
