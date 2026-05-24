export interface OnboardingState {
  configured: boolean;
}

export interface ValidateProviderRequest {
  provider: 'anthropic' | 'openai' | 'openrouter' | 'azure';
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export interface ValidateProviderResponse {
  valid: boolean;
  completionTested: boolean;
  error?: string;
  errorCode?: 'invalid_key' | 'no_credits' | 'model_not_found' | 'other';
  models?: string[];
}

export interface OnboardingCompleteRequest {
  provider: 'anthropic' | 'openai' | 'openrouter' | 'azure';
  model: string;
  apiKey: string;
  personalityId: string;
  baseUrl?: string;
}

export interface PersonalityListItem {
  id: string;
  name: string;
  description: string;
  accent: string;
  isBuiltin: boolean;
}

export interface ChatSendRequest {
  message: string;
  sessionId?: string;
}

export type ProviderType = 'anthropic' | 'openai' | 'openrouter' | 'azure' | 'ollama';

export interface ConfigGetResponse {
  provider: ProviderType;
  model: string;
  compressionModel?: string;
  visionModel?: string;
  baseUrl?: string;
  apiKeyPreview: string | null;
  memory: 'markdown' | 'vector';
  approvalMode: 'manual' | 'smart' | 'off';
  contextLayering: boolean;
  debugMode: boolean;
  verbosity: 'concise' | 'balanced' | 'verbose';
  messageFontSize: number;
  codeBlockFontSize: number;
  theme: 'dark' | 'light' | 'system';
  retentionDays: number;
  traceLogDays: number;
  observabilityDays: number;
  autoUpdate: boolean;
  launchAtLogin: boolean;
  providers: Record<string, string[]>;
}

export interface ConfigUpdateRequest {
  provider?: ProviderType;
  model?: string;
  compressionModel?: string;
  visionModel?: string;
  baseUrl?: string;
  memory?: 'markdown' | 'vector';
  approvalMode?: 'manual' | 'smart' | 'off';
  contextLayering?: boolean;
  debugMode?: boolean;
  verbosity?: 'concise' | 'balanced' | 'verbose';
  messageFontSize?: number;
  codeBlockFontSize?: number;
  theme?: 'dark' | 'light' | 'system';
  retentionDays?: number;
  traceLogDays?: number;
  observabilityDays?: number;
  autoUpdate?: boolean;
  launchAtLogin?: boolean;
}

export interface RetentionValues {
  retentionDays: number;
  traceLogDays: number;
  observabilityDays: number;
}

export interface IpcContract {
  'onboarding:state': { request: undefined; response: OnboardingState };
  'onboarding:validateProvider': {
    request: ValidateProviderRequest;
    response: ValidateProviderResponse;
  };
  'onboarding:complete': { request: OnboardingCompleteRequest; response: { success: boolean } };
  'personalities:list': { request: undefined; response: PersonalityListItem[] };
  'backend:port': { request: undefined; response: number };
  'backend:start': { request: { port: number }; response: { started: boolean } };
  'health:check': { request: { port: number }; response: { healthy: boolean } };
  'theme:get': { request: undefined; response: 'dark' | 'light' };
  'advancedMode:get': { request: undefined; response: boolean };
  'advancedMode:set': { request: { enabled: boolean }; response: { ok: boolean } };
  'chat:send': { request: ChatSendRequest; response: { sessionId: string } };
  'theme:set': { request: { theme: 'dark' | 'light' | 'system' }; response: { ok: boolean } };
  'keychain:set': { request: { key: string; value: string }; response: { ok: boolean } };
  'keychain:preview': { request: { key: string }; response: { preview: string | null } };
  'config:get': { request: undefined; response: ConfigGetResponse };
  'config:update': { request: ConfigUpdateRequest; response: { ok: boolean; error?: string } };
  'shell:openConfigFolder': { request: undefined; response: { ok: boolean } };
  'export:data': {
    request: undefined;
    response: { ok: boolean; path?: string; error?: string };
  };
  'retention:prune': {
    request: RetentionValues;
    response: { ok: boolean; freedBytes?: number; error?: string };
  };
  'shell:openExternal': { request: { url: string }; response: { ok: boolean } };
  'dialog:showOpenDialog': {
    request: { properties: string[] };
    response: { canceled: boolean; filePaths: string[] };
  };
}

/** Main-to-renderer push events (via webContents.send, NOT ipcMain.handle) */
export interface RendererEvents {
  'chat:new': undefined;
  'navigate:session': { sessionId: string };
  'oauth:callback': { code: string; state: string };
}

export const RENDERER_EVENTS = {
  'chat:new': 'chat:new',
  'navigate:session': 'navigate:session',
  'oauth:callback': 'oauth:callback',
} as const;

export type IpcChannel = keyof IpcContract;

export const IPC_CHANNELS: { [K in IpcChannel]: K } = {
  'onboarding:state': 'onboarding:state',
  'onboarding:validateProvider': 'onboarding:validateProvider',
  'onboarding:complete': 'onboarding:complete',
  'personalities:list': 'personalities:list',
  'backend:port': 'backend:port',
  'backend:start': 'backend:start',
  'health:check': 'health:check',
  'theme:get': 'theme:get',
  'advancedMode:get': 'advancedMode:get',
  'advancedMode:set': 'advancedMode:set',
  'chat:send': 'chat:send',
  'theme:set': 'theme:set',
  'keychain:set': 'keychain:set',
  'keychain:preview': 'keychain:preview',
  'config:get': 'config:get',
  'config:update': 'config:update',
  'shell:openConfigFolder': 'shell:openConfigFolder',
  'export:data': 'export:data',
  'retention:prune': 'retention:prune',
  'shell:openExternal': 'shell:openExternal',
  'dialog:showOpenDialog': 'dialog:showOpenDialog',
};
