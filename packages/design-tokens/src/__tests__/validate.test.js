import { describe, expect, it } from 'vitest';
import { DEFAULT_TOKENS } from '../index';
import { BUILTIN_SKINS } from '../skins';
import { contrastRatio, hexToHue, validateSkin, validateTokens } from '../validate';

describe('hexToHue', () => {
  it('returns the hue in degrees for a saturated color', () => {
    expect(hexToHue('#FF0000')).toBeCloseTo(0, 0);
    expect(hexToHue('#00FF00')).toBeCloseTo(120, 0);
    expect(hexToHue('#0000FF')).toBeCloseTo(240, 0);
  });
  it('identifies the purple/violet band', () => {
    const violet = hexToHue('#8B5CF6');
    expect(violet).not.toBeNull();
    // Tailwind violet 500 sits around 258°, comfortably inside the slop band.
    expect(violet).toBeGreaterThan(240);
    expect(violet).toBeLessThan(290);
  });
  it('returns null for greys (no hue)', () => {
    expect(hexToHue('#808080')).toBeNull();
    expect(hexToHue('#FFFFFF')).toBeNull();
  });
  it('returns null for malformed hex', () => {
    expect(hexToHue('not-a-hex')).toBeNull();
    expect(hexToHue('#FFF')).toBeNull(); // 3-char shorthand not supported
  });
});
describe('contrastRatio', () => {
  it('matches WCAG canonical pairs', () => {
    // Black on white = 21, the max possible.
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
    // Same color = 1 (zero contrast).
    expect(contrastRatio('#4A9EFF', '#4A9EFF')).toBeCloseTo(1, 0);
  });
  it('hits DESIGN.md targeted ~14:1 for textPrimary on bgBase', () => {
    const ratio = contrastRatio(DEFAULT_TOKENS.surface.textPrimary, DEFAULT_TOKENS.surface.bgBase);
    // DESIGN.md says "Contrast ~14:1" — give the assertion a couple of
    // points of slack on either side since the spec is approximate.
    expect(ratio).toBeGreaterThan(13);
    expect(ratio).toBeLessThan(17);
  });
});
describe('validateTokens (positive cases)', () => {
  it('DEFAULT_TOKENS passes every rule', () => {
    const result = validateTokens(DEFAULT_TOKENS);
    expect(result.valid).toBe(true);
    expect(result.findings).toHaveLength(0);
  });
  it('every built-in skin resolves to valid tokens', () => {
    for (const name of Object.keys(BUILTIN_SKINS)) {
      const result = validateSkin(BUILTIN_SKINS[name]);
      expect(
        result.valid,
        `built-in skin "${name}" failed validation: ${result.findings.map((f) => f.message).join('; ')}`,
      ).toBe(true);
    }
  });
});
describe('validateTokens (negative cases)', () => {
  function withOverride(overrides) {
    return { ...DEFAULT_TOKENS, ...overrides };
  }
  it('rejects a purple accent (Tailwind violet)', () => {
    const result = validateTokens(
      withOverride({ accents: { ...DEFAULT_TOKENS.accents, researcher: '#8B5CF6' } }),
    );
    expect(result.valid).toBe(false);
    const codes = result.findings.map((f) => f.code);
    expect(codes).toContain('forbidden-accent-hue');
    expect(result.findings.find((f) => f.code === 'forbidden-accent-hue')?.path).toBe(
      'accents.researcher',
    );
  });
  it('rejects an indigo accent (Tailwind indigo 600)', () => {
    // #4F46E5 lands around 243° — inside the [240, 290] slop band.
    const result = validateTokens(
      withOverride({ accents: { ...DEFAULT_TOKENS.accents, coach: '#4F46E5' } }),
    );
    expect(result.findings.some((f) => f.code === 'forbidden-accent-hue')).toBe(true);
  });
  it('rejects a low-contrast surface (dark grey text on dark bg)', () => {
    const result = validateTokens(
      withOverride({
        surface: { ...DEFAULT_TOKENS.surface, textPrimary: '#3A3A3A', bgBase: '#0F0F0F' },
      }),
    );
    expect(result.findings.some((f) => f.code === 'low-contrast')).toBe(true);
  });
  it('rejects Comic Sans as fontDisplay', () => {
    const result = validateTokens(
      withOverride({
        typography: {
          ...DEFAULT_TOKENS.typography,
          fontDisplay: 'Comic Sans MS, cursive',
        },
      }),
    );
    expect(result.findings.some((f) => f.code === 'font-family-forbidden')).toBe(true);
  });
  it('rejects a radius value off the DESIGN.md scale (e.g. 6)', () => {
    const result = validateTokens(withOverride({ radius: { ...DEFAULT_TOKENS.radius, md: 6 } }));
    expect(result.findings.some((f) => f.code === 'radius-off-scale')).toBe(true);
  });
  it('rejects a 1000ms motion duration', () => {
    const result = validateTokens(
      withOverride({
        motion: { ...DEFAULT_TOKENS.motion, defaultMs: 1000 },
      }),
    );
    expect(result.findings.some((f) => f.code === 'motion-out-of-range')).toBe(true);
  });
  it('accepts motion = 0 (skin disables motion)', () => {
    const result = validateTokens(
      withOverride({
        motion: { ...DEFAULT_TOKENS.motion, fastMs: 0, defaultMs: 0, slowMs: 0 },
      }),
    );
    expect(result.findings.some((f) => f.code === 'motion-out-of-range')).toBe(false);
  });
});
describe('validateSkin', () => {
  it('catches violations in the resolved tokens, not the override partial', () => {
    // The override itself only sets one purple accent — but after resolve,
    // the offending value reaches the validator and is caught.
    const naughty = {
      name: 'naughty',
      description: 'oops',
      tokens: {
        accents: { researcher: '#8B5CF6' },
      },
    };
    const result = validateSkin(naughty);
    expect(result.valid).toBe(false);
    expect(result.findings[0].code).toBe('forbidden-accent-hue');
  });
  it('resolves through extends before validating', () => {
    const purpleParent = {
      name: 'purple-parent',
      description: '',
      tokens: { accents: { researcher: '#8B5CF6' } },
    };
    const cleanChild = {
      name: 'clean-child',
      description: '',
      extends: 'purple-parent',
      tokens: {},
    };
    const result = validateSkin(cleanChild, DEFAULT_TOKENS, { 'purple-parent': purpleParent });
    expect(result.valid).toBe(false); // inherited purple still trips the validator
  });
});
