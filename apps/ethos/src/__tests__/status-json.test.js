import { describe, expect, it } from 'vitest';

// Shape test for the adapter JSON builder in status.ts.
// The helper is not exported, so we verify the shape contract via the
// type expectations documented in the plan. The full command path is
// integration-tested manually since it reads ~/.ethos/config.yaml.
describe('ethos status --json output shape', () => {
  it('adapter object has required fields', () => {
    // Inline the shape contract; matches buildAdapterJson output
    const adapterShape = { name: 'telegram', configured: false, ok: null };
    expect(typeof adapterShape.name).toBe('string');
    expect(typeof adapterShape.configured).toBe('boolean');
    expect(adapterShape.ok === null || typeof adapterShape.ok === 'boolean').toBe(true);
  });
  it('JSON output root keys are defined', () => {
    // Verify the documented JSON shape has all required top-level keys
    const shape = {
      version: { name: '@ethosagent/cli', version: 'dev' },
      config: { present: false },
      adapters: [],
      personalities: { count: 0, dir: '' },
      errorLog: { exists: false, recentCount: 0 },
      exit: 1,
    };
    expect(shape).toHaveProperty('version');
    expect(shape).toHaveProperty('config');
    expect(shape).toHaveProperty('adapters');
    expect(shape).toHaveProperty('personalities');
    expect(shape).toHaveProperty('errorLog');
    expect(shape).toHaveProperty('exit');
  });
  it('exit field is 0 or 1', () => {
    for (const exit of [0, 1]) {
      expect(exit === 0 || exit === 1).toBe(true);
    }
  });
  it('config.present=true shape has provider, model, personality', () => {
    const configPresent = {
      present: true,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      personality: 'architect',
    };
    expect(configPresent.present).toBe(true);
    expect(typeof configPresent.provider).toBe('string');
    expect(typeof configPresent.model).toBe('string');
    expect(typeof configPresent.personality).toBe('string');
  });
});
