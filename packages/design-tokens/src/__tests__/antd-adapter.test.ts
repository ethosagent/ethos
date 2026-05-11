import { theme } from 'antd';
import { describe, expect, it } from 'vitest';
import { isLightSurface, surfaceLuminance, tokensToAntd, tokensToCssVariables } from '../antd';
import { DEFAULT_TOKENS } from '../index';
import { resolveBuiltinSkin } from '../skins';

// Antd adapter — load-bearing on the Web side. The bug these tests guard:
// hardcoding `theme.darkAlgorithm` in main.tsx made `paper` skin emit
// dark-mode derived tokens (text, hover, border) on top of a light surface,
// producing white-on-white text. The adapter now picks the algorithm from
// the resolved tokens themselves so skin choice propagates end-to-end.

describe('surfaceLuminance', () => {
  it('returns 0 for black and ~1 for white', () => {
    expect(surfaceLuminance('#000000')).toBe(0);
    expect(surfaceLuminance('#FFFFFF')).toBeCloseTo(1, 3);
  });

  it('places DESIGN.md surfaces on the correct side of the midpoint', () => {
    expect(surfaceLuminance('#0F0F0F')).toBeLessThan(0.5); // dark bgBase
    expect(surfaceLuminance('#FAFAF7')).toBeGreaterThan(0.5); // paper bgBase
  });

  it('returns 0 for malformed hex (defensive)', () => {
    expect(surfaceLuminance('not-a-hex')).toBe(0);
    expect(surfaceLuminance('#FFF')).toBe(0); // 3-char shorthand not supported
  });
});

describe('isLightSurface', () => {
  it('is false for the default DESIGN.md dark surface', () => {
    expect(isLightSurface(DEFAULT_TOKENS)).toBe(false);
  });

  it('is true after resolving the paper skin', () => {
    expect(isLightSurface(resolveBuiltinSkin('paper'))).toBe(true);
  });

  it('is false for mono (mono only desaturates accents — surface stays dark)', () => {
    expect(isLightSurface(resolveBuiltinSkin('mono'))).toBe(false);
  });
});

describe('tokensToAntd algorithm selection', () => {
  it('default skin → darkAlgorithm', () => {
    expect(tokensToAntd(DEFAULT_TOKENS).algorithm).toBe(theme.darkAlgorithm);
  });

  it('mono skin → darkAlgorithm (surface unchanged)', () => {
    expect(tokensToAntd(resolveBuiltinSkin('mono')).algorithm).toBe(theme.darkAlgorithm);
  });

  it('paper skin → defaultAlgorithm', () => {
    expect(tokensToAntd(resolveBuiltinSkin('paper')).algorithm).toBe(theme.defaultAlgorithm);
  });
});

describe('tokensToAntd token mapping', () => {
  it('routes surface text colors into Antd text tokens', () => {
    const { token } = tokensToAntd(resolveBuiltinSkin('paper'));
    expect(token?.colorText).toBe('#1A1A1A');
    expect(token?.colorBgLayout).toBe('#FAFAF7');
  });

  it('converts motion ms → s for Antd', () => {
    const { token } = tokensToAntd(DEFAULT_TOKENS);
    expect(token?.motionDurationFast).toBe('0.08s');
    expect(token?.motionDurationMid).toBe('0.18s');
    expect(token?.motionDurationSlow).toBe('0.24s');
  });
});

describe('tokensToCssVariables', () => {
  it('emits both surface and layout vars in one :root block', () => {
    const css = tokensToCssVariables(DEFAULT_TOKENS);
    expect(css).toMatch(/^:root \{/);
    expect(css.trim().endsWith('}')).toBe(true);
    expect(css).toContain('--ethos-bg: #0F0F0F');
    expect(css).toContain('--ethos-text: #E8E8E6');
    expect(css).toContain('--layout-sidebar-expanded: 240px');
    expect(css).toContain('--layout-right-drawer: 360px');
  });

  it('flips surface vars to light values under the paper skin', () => {
    const css = tokensToCssVariables(resolveBuiltinSkin('paper'));
    expect(css).toContain('--ethos-bg: #FAFAF7');
    expect(css).toContain('--ethos-text: #1A1A1A');
    expect(css).toContain('--ethos-bg-elevated: #FFFFFF');
  });
});
