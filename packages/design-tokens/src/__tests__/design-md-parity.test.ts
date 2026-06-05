import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOKENS } from '../index';

// Parses DESIGN.md and asserts DEFAULT_TOKENS mirrors it exactly. The
// canonical written reference is DESIGN.md; this test fails on drift
// either direction so a hex change in one place is visible.

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const designMd = readFileSync(join(REPO_ROOT, 'DESIGN.md'), 'utf8');

const HEX_PATTERN = /`(#[0-9A-Fa-f]{6})`/;

function rowFor(token: string): string | null {
  const line = designMd
    .split('\n')
    .find((l) => l.startsWith(`| \`--${token}\``) || l.startsWith(`| \`${token}\``));
  return line ?? null;
}

function darkHexFor(token: string): string | null {
  const row = rowFor(token);
  if (!row) return null;
  const match = row.match(HEX_PATTERN);
  return match ? match[1].toUpperCase() : null;
}

function personalityHexFor(name: string): string | null {
  const line = designMd.split('\n').find((l) => l.startsWith(`| ${name} |`));
  if (!line) return null;
  const match = line.match(HEX_PATTERN);
  return match ? match[1].toUpperCase() : null;
}

describe('DEFAULT_TOKENS parity with DESIGN.md', () => {
  describe('surface tokens (dark mode)', () => {
    const cases: Array<[string, keyof typeof DEFAULT_TOKENS.surface]> = [
      ['bg-base', 'bgBase'],
      ['bg-elevated', 'bgElevated'],
      ['bg-overlay', 'bgOverlay'],
      ['border-subtle', 'borderSubtle'],
      ['border-strong', 'borderStrong'],
      ['text-primary', 'textPrimary'],
      ['text-secondary', 'textSecondary'],
      ['text-tertiary', 'textTertiary'],
    ];
    for (const [designName, tokenKey] of cases) {
      it(`surface.${tokenKey} matches DESIGN.md --${designName}`, () => {
        const expected = darkHexFor(designName);
        expect(expected, `DESIGN.md row for --${designName} not found`).not.toBeNull();
        expect(DEFAULT_TOKENS.surface[tokenKey].toUpperCase()).toBe(expected);
      });
    }
  });

  describe('personality accents', () => {
    const personalities = ['researcher', 'engineer', 'reviewer', 'coach', 'operator'] as const;
    for (const id of personalities) {
      it(`accents.${id} matches the DESIGN.md personality table`, () => {
        const expected = personalityHexFor(id);
        expect(expected, `DESIGN.md row for ${id} not found`).not.toBeNull();
        const actual = DEFAULT_TOKENS.accents[id];
        expect(actual, `accents.${id} missing from DEFAULT_TOKENS`).toBeDefined();
        expect((actual as string).toUpperCase()).toBe(expected);
      });
    }
  });

  describe('semantic colors', () => {
    const cases: Array<[string, keyof typeof DEFAULT_TOKENS.semantic]> = [
      ['success', 'success'],
      ['warning', 'warning'],
      ['error', 'error'],
      ['info', 'info'],
    ];
    for (const [designName, tokenKey] of cases) {
      it(`semantic.${tokenKey} matches DESIGN.md --${designName}`, () => {
        const expected = darkHexFor(designName);
        expect(expected, `DESIGN.md row for --${designName} not found`).not.toBeNull();
        expect(DEFAULT_TOKENS.semantic[tokenKey].toUpperCase()).toBe(expected);
      });
    }
  });

  describe('numerics', () => {
    it('radius scale matches DESIGN.md (4 / 8 / 14 / full)', () => {
      expect(DEFAULT_TOKENS.radius).toEqual({ sm: 4, md: 8, lg: 14, full: 9999 });
    });

    it('motion durations match DESIGN.md (80 / 180 / 240 ms)', () => {
      expect(DEFAULT_TOKENS.motion.fastMs).toBe(80);
      expect(DEFAULT_TOKENS.motion.defaultMs).toBe(180);
      expect(DEFAULT_TOKENS.motion.slowMs).toBe(240);
      expect(DEFAULT_TOKENS.motion.ease).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
    });

    it('spacing scale matches DESIGN.md (4/8/12/16/24/32/48/64/96)', () => {
      expect(DEFAULT_TOKENS.spacing).toEqual({
        xs: 4,
        sm: 8,
        md: 12,
        lg: 16,
        xl: 24,
        '2xl': 32,
        '3xl': 48,
        '4xl': 64,
        '5xl': 96,
      });
    });

    it('layout dimensions match DESIGN.md (240/64/360/800/520)', () => {
      expect(DEFAULT_TOKENS.layout).toEqual({
        sidebarExpandedPx: 240,
        sidebarCollapsedPx: 64,
        rightDrawerPx: 360,
        chatMaxWidthPx: 800,
        onboardingMaxWidthPx: 520,
      });
    });
  });

  describe('typography', () => {
    it('uses Geist + Geist Mono per DESIGN.md', () => {
      expect(DEFAULT_TOKENS.typography.fontDisplay).toMatch(/Geist/);
      expect(DEFAULT_TOKENS.typography.fontMono).toMatch(/Geist Mono/);
    });

    it('h1 / body / micro / mono px sizes match DESIGN.md', () => {
      expect(DEFAULT_TOKENS.typography.scale.h1.px).toBe(32);
      expect(DEFAULT_TOKENS.typography.scale.body.px).toBe(14);
      expect(DEFAULT_TOKENS.typography.scale.micro.px).toBe(11);
      expect(DEFAULT_TOKENS.typography.scale.mono.px).toBe(13);
    });
  });

  describe('parser sanity', () => {
    it('finds the surface rows in DESIGN.md', () => {
      expect(darkHexFor('bg-base')).toBe('#0F0F0F');
      expect(darkHexFor('text-primary')).toBe('#E8E8E6');
    });

    it('finds the personality rows in DESIGN.md', () => {
      expect(personalityHexFor('researcher')).toBe('#4A9EFF');
      expect(personalityHexFor('operator')).toBe('#94A3B8');
    });
  });
});
