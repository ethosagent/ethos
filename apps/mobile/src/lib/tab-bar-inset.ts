/**
 * Bottom clearance a screen under the floating tab bar needs, so its last
 * scrollable row — or the chat composer — sits clear of the pill. Once the
 * keyboard is up the composer already rides the keyboard height via
 * `KeyboardStickyView`'s own transform, and the floating tab bar retreats
 * behind the keyboard, so no extra clearance is added on top of it: a static
 * inset that stayed applied with the keyboard open would double-count and
 * leave a gap above the keyboard instead of the composer sitting on it.
 */
export function tabBarBottomInset(args: {
  tabBarHeight: number;
  safeAreaBottom: number;
  keyboardVisible: boolean;
}): number {
  return args.keyboardVisible ? 0 : args.tabBarHeight + args.safeAreaBottom;
}
