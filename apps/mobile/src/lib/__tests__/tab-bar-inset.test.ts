import { describe, expect, it } from 'vitest';
import { tabBarBottomInset } from '../tab-bar-inset';

describe('tabBarBottomInset', () => {
  it('clears the pill plus the safe area at rest', () => {
    expect(
      tabBarBottomInset({ tabBarHeight: 64, safeAreaBottom: 34, keyboardVisible: false }),
    ).toBe(98);
  });

  it('drops to zero once the keyboard is up, so it never doubles the keyboard offset', () => {
    expect(tabBarBottomInset({ tabBarHeight: 64, safeAreaBottom: 34, keyboardVisible: true })).toBe(
      0,
    );
  });

  it('a device with no safe-area-bottom inset still clears the pill', () => {
    expect(tabBarBottomInset({ tabBarHeight: 64, safeAreaBottom: 0, keyboardVisible: false })).toBe(
      64,
    );
  });
});
