import Store from 'electron-store';

export interface AppStoreType {
  theme: 'dark' | 'light';
  onboardingComplete: boolean;
  provider?: 'anthropic' | 'openai' | 'openrouter' | 'azure';
  model?: string;
  personalityId?: string;
  windowBounds?: { x: number; y: number; width: number; height: number };
}

export const store = new Store<AppStoreType>({
  defaults: {
    theme: 'dark',
    onboardingComplete: false,
  },
});
