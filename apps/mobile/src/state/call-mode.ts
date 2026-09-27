import { create } from 'zustand';

// The Call Stage as a MODE (§2, T7): while the stage is focused the tab bar is
// hidden — `app/(tabs)/_layout.tsx` reads `stageFocused` into `<NativeTabs
// hidden>` (expo-router 57's `NativeTabsProps.hidden`, which the iOS view
// passes to react-native-screens as `tabBarHidden`). The stage route sets it on
// focus and clears it on blur, so a swipe back or Back to chat both restore it.
//
// `owner` is the personality and session the live call was started for, so the
// chat's "call in progress" strip can return to the stage with the right
// params from any chat. It stays set past hang-up; the strip only renders
// while `callStripVisible` says there is something to show.

export interface CallOwner {
  personalityId: string | null;
  sessionId: string | null;
}

interface CallModeStore {
  stageFocused: boolean;
  owner: CallOwner | null;
  setStageFocused(focused: boolean): void;
  setOwner(owner: CallOwner): void;
}

export const useCallMode = create<CallModeStore>((set) => ({
  stageFocused: false,
  owner: null,
  setStageFocused: (stageFocused) => set({ stageFocused }),
  setOwner: (owner) => set({ owner }),
}));
