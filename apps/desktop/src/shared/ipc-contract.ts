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
}

/** Main-to-renderer push events (via webContents.send, NOT ipcMain.handle) */
export interface RendererEvents {
  'chat:new': undefined;
  'navigate:session': { sessionId: string };
}

export const RENDERER_EVENTS = {
  'chat:new': 'chat:new',
  'navigate:session': 'navigate:session',
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
};
