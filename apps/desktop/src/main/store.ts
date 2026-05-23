import Store from 'electron-store';

export interface AppStoreType {
  theme: 'dark' | 'light' | 'system';
  onboardingComplete: boolean;
  advancedMode: boolean;
  provider?: 'anthropic' | 'openai' | 'openrouter' | 'azure' | 'ollama';
  model?: string;
  compressionModel?: string;
  visionModel?: string;
  baseUrl?: string;
  personalityId?: string;
  windowBounds?: { x: number; y: number; width: number; height: number };
  memory: 'markdown' | 'vector';
  approvalMode: 'manual' | 'smart' | 'off';
  contextLayering: boolean;
  debugMode: boolean;
  verbosity: 'concise' | 'balanced' | 'verbose';
  messageFontSize: number;
  codeBlockFontSize: number;
  retentionDays: number;
  traceLogDays: number;
  observabilityDays: number;
  autoUpdate: boolean;
  launchAtLogin: boolean;
}

export const store = new Store<AppStoreType>({
  defaults: {
    theme: 'dark',
    onboardingComplete: false,
    advancedMode: false,
    memory: 'markdown',
    approvalMode: 'manual',
    contextLayering: false,
    debugMode: false,
    verbosity: 'balanced',
    messageFontSize: 14,
    codeBlockFontSize: 13,
    retentionDays: 90,
    traceLogDays: 30,
    observabilityDays: 7,
    autoUpdate: true,
    launchAtLogin: false,
  },
});
