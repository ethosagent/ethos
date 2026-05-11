import { describe, expect, it } from 'vitest';
import { personalityTheme } from '../theme';

// Phase 3 resolution order — the chat tab's inner ConfigProvider.

describe('personalityTheme', () => {
  it('user pin set → only overrides the accent (outer provider carries the pinned palette)', () => {
    const theme = personalityTheme('engineer', { userPin: 'mono' });
    expect(theme.token?.colorPrimary).toBe('#4ADE80'); // engineer accent
    // No surface/components overrides — outer provider already has 'mono'.
    expect(theme.components).toBeUndefined();
  });

  it('user pin = "default" treated as no pin (personality skin can still apply)', () => {
    const theme = personalityTheme('engineer', { userPin: 'default', personalitySkin: 'paper' });
    // Paper applied — chat subtree gets the light-mode surface.
    expect(theme.token?.colorBgLayout).toBe('#FAFAF7');
    expect(theme.token?.colorPrimary).toBe('#4ADE80');
  });

  it("no user pin + personality skin set → applies the personality skin's full tokens", () => {
    const theme = personalityTheme('reviewer', { userPin: null, personalitySkin: 'paper' });
    expect(theme.token?.colorBgLayout).toBe('#FAFAF7'); // paper light bg
    expect(theme.token?.colorPrimary).toBe('#F59E0B'); // reviewer accent
  });

  it('no user pin + no personality skin → just accent override', () => {
    const theme = personalityTheme('coach', { userPin: null, personalitySkin: null });
    expect(theme.token?.colorPrimary).toBe('#E879F9');
    expect(theme.components).toBeUndefined();
  });

  it('unknown personality skin name falls back to accent-only override', () => {
    const theme = personalityTheme('engineer', {
      userPin: null,
      personalitySkin: 'not-a-real-skin',
    });
    expect(theme.token?.colorPrimary).toBe('#4ADE80');
    expect(theme.components).toBeUndefined();
  });

  it('default options (no userPin or personalitySkin) → accent-only override', () => {
    const theme = personalityTheme('researcher');
    expect(theme.token?.colorPrimary).toBe('#4A9EFF');
    expect(theme.components).toBeUndefined();
  });
});
