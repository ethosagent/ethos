import Store from 'electron-store';

export interface AppStoreType {
  theme: 'dark' | 'light';
  onboardingComplete: boolean;
  advancedMode: boolean;
  provider?: 'anthropic' | 'openai' | 'openrouter' | 'azure';
  model?: string;
  personalityId?: string;
  backendPort: number;
  windowBounds?: { x: number; y: number; width: number; height: number };
  hasShownMinimizeHint?: boolean;
  hasShownHotkeyConflict?: boolean;
}

export const store = new Store<AppStoreType>({
  defaults: {
    theme: 'dark',
    onboardingComplete: false,
    advancedMode: false,
    backendPort: 3001,
  },
});
