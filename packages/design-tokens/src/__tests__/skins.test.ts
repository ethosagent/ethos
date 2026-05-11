import { describe, expect, it } from 'vitest';
import { DEFAULT_TOKENS } from '../index';
import {
  BUILTIN_SKIN_NAMES,
  BUILTIN_SKINS,
  deepMerge,
  resolveBuiltinSkin,
  resolveSkin,
  type Skin,
  type SkinRegistry,
} from '../skins';

describe('BUILTIN_SKINS', () => {
  it('ships default, mono, paper', () => {
    expect([...BUILTIN_SKIN_NAMES].sort()).toEqual(['default', 'mono', 'paper']);
  });

  it('every built-in carries name + description metadata', () => {
    for (const name of BUILTIN_SKIN_NAMES) {
      const skin = BUILTIN_SKINS[name];
      expect(skin.name).toBe(name);
      expect(skin.description.length).toBeGreaterThan(0);
    }
  });
});

describe('deepMerge', () => {
  it('replaces primitives wholesale', () => {
    expect(deepMerge({ a: 1, b: 2 }, { a: 10 } as { a?: number; b?: number })).toEqual({
      a: 10,
      b: 2,
    });
  });

  it('merges nested objects key-by-key', () => {
    const base = { surface: { bg: 'black', text: 'white' } };
    const overrides = { surface: { bg: 'paper' } };
    expect(deepMerge(base, overrides)).toEqual({ surface: { bg: 'paper', text: 'white' } });
  });

  it('replaces arrays wholesale (no concatenation)', () => {
    const base = { list: [1, 2, 3] };
    const overrides = { list: [10] };
    expect(deepMerge(base, overrides)).toEqual({ list: [10] });
  });

  it('ignores undefined overrides — leaves base intact', () => {
    const base = { a: 1, b: 2 };
    const overrides = { a: undefined };
    expect(deepMerge(base, overrides as { a?: number })).toEqual({ a: 1, b: 2 });
  });
});

describe('resolveSkin (built-in skins)', () => {
  it('default skin equals DEFAULT_TOKENS verbatim', () => {
    const resolved = resolveBuiltinSkin('default');
    expect(resolved).toEqual(DEFAULT_TOKENS);
  });

  it('mono desaturates every personality accent to text-secondary', () => {
    const resolved = resolveBuiltinSkin('mono');
    const muted = DEFAULT_TOKENS.surface.textSecondary;
    for (const id of Object.keys(DEFAULT_TOKENS.accents)) {
      expect(resolved.accents[id]).toBe(muted);
    }
  });

  it('mono leaves semantic colors + surface untouched', () => {
    const resolved = resolveBuiltinSkin('mono');
    expect(resolved.semantic).toEqual(DEFAULT_TOKENS.semantic);
    expect(resolved.surface).toEqual(DEFAULT_TOKENS.surface);
  });

  it('paper swaps the full dark surface for the light surface', () => {
    const resolved = resolveBuiltinSkin('paper');
    expect(resolved.surface.bgBase).toBe('#FAFAF7');
    expect(resolved.surface.textPrimary).toBe('#1A1A1A');
    expect(resolved.surface.bgElevated).toBe('#FFFFFF');
  });

  it('paper keeps personality accents intact', () => {
    const resolved = resolveBuiltinSkin('paper');
    expect(resolved.accents).toEqual(DEFAULT_TOKENS.accents);
  });
});

describe('resolveSkin (extends chain)', () => {
  it('walks a multi-level extends chain', () => {
    const registry: SkinRegistry = {
      base: { name: 'base', description: '', tokens: { accents: { researcher: '#111111' } } },
      mid: {
        name: 'mid',
        description: '',
        extends: 'base',
        tokens: { accents: { engineer: '#222222' } },
      },
      leaf: {
        name: 'leaf',
        description: '',
        extends: 'mid',
        tokens: { accents: { reviewer: '#333333' } },
      },
    };
    const tokens = resolveSkin(DEFAULT_TOKENS, registry, 'leaf');
    expect(tokens.accents.researcher).toBe('#111111');
    expect(tokens.accents.engineer).toBe('#222222');
    expect(tokens.accents.reviewer).toBe('#333333');
    // coach + operator remain at DEFAULT_TOKENS values
    expect(tokens.accents.coach).toBe(DEFAULT_TOKENS.accents.coach);
  });

  it('child overrides win over parent', () => {
    const registry: SkinRegistry = {
      parent: {
        name: 'parent',
        description: '',
        tokens: { accents: { researcher: '#111111' } },
      },
      child: {
        name: 'child',
        description: '',
        extends: 'parent',
        tokens: { accents: { researcher: '#222222' } },
      },
    };
    expect(resolveSkin(DEFAULT_TOKENS, registry, 'child').accents.researcher).toBe('#222222');
  });

  it('throws on unknown skin name', () => {
    expect(() => resolveSkin(DEFAULT_TOKENS, BUILTIN_SKINS, 'nonexistent')).toThrow(
      /Unknown skin: "nonexistent"/,
    );
  });

  it('throws on extends-chain cycle', () => {
    const registry: SkinRegistry = {
      a: { name: 'a', description: '', extends: 'b', tokens: {} },
      b: { name: 'b', description: '', extends: 'a', tokens: {} },
    };
    expect(() => resolveSkin(DEFAULT_TOKENS, registry, 'a')).toThrow(/cycle/);
  });

  it('throws when extends points to a missing skin', () => {
    const registry: SkinRegistry = {
      orphan: { name: 'orphan', description: '', extends: 'ghost', tokens: {} },
    };
    expect(() => resolveSkin(DEFAULT_TOKENS, registry, 'orphan')).toThrow(/Unknown skin: "ghost"/);
  });
});

describe('Skin shape (type-level + runtime sanity)', () => {
  it('a skin with no overrides is a valid Skin', () => {
    const skin: Skin = { name: 'noop', description: 'no-op', tokens: {} };
    expect(skin.tokens).toEqual({});
  });
});
