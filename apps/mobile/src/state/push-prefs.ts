import type { PushCategories } from '@ethosagent/web-contracts';
import { create } from 'zustand';
import { DEFAULT_PUSH_CATEGORIES } from '../push/registration';

// This phone's push category choices (D11) — the booleans `push.register`
// carries. One store so More › Settings and a team's Settings show the same
// switch. In-memory like the rest of the app's device state: the server's
// device row is the durable copy, re-sent on every `registerForPush`.
interface PushPrefs {
  categories: PushCategories;
  set(next: PushCategories): void;
}

export const usePushPrefs = create<PushPrefs>((set) => ({
  categories: DEFAULT_PUSH_CATEGORIES,
  set: (categories) => set({ categories }),
}));
