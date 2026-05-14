import { describe, expect, it } from 'vitest';
import { personalityTheme } from '../theme';

// The chat tab's inner ConfigProvider. Per-personality skin overrides were
// removed in the personality-alignment phase — `personalityTheme` now only
// re-tints the accent per personality; the outer provider carries whatever
// skin the user pinned in `~/.ethos/config.yaml`.

describe('personalityTheme', () => {
  it('re-tints the accent per personality and adds no component overrides', () => {
    const theme = personalityTheme('engineer');
    expect(theme.token?.colorPrimary).toBe('#4ADE80'); // engineer accent
    expect(theme.components).toBeUndefined();
  });

  it('different personalities resolve to different accents', () => {
    expect(personalityTheme('reviewer').token?.colorPrimary).toBe('#F59E0B');
    expect(personalityTheme('coach').token?.colorPrimary).toBe('#E879F9');
    expect(personalityTheme('researcher').token?.colorPrimary).toBe('#4A9EFF');
  });
});
