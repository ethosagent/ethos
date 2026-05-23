export interface OnboardingState {
  configured: boolean;
}

export interface ValidateProviderRequest {
  provider: 'anthropic' | 'openai' | 'ollama';
  apiKey: string;
  baseUrl?: string;
}

export interface ValidateProviderResponse {
  valid: boolean;
  completionTested: boolean;
  error?: string;
  errorCode?: 'invalid_key' | 'no_credits' | 'model_not_found' | 'other';
  models?: string[];
}

export interface OnboardingCompleteRequest {
  provider: 'anthropic' | 'openai' | 'ollama';
  model: string;
  apiKey: string;
  personalityId: string;
}

export interface PersonalityListItem {
  id: string;
  name: string;
  description: string;
  accent: string;
  isBuiltin: boolean;
}

export interface IpcContract {
  'onboarding:state': { request: undefined; response: OnboardingState };
  'onboarding:validateProvider': {
    request: ValidateProviderRequest;
    response: ValidateProviderResponse;
  };
  'onboarding:complete': { request: OnboardingCompleteRequest; response: { success: boolean } };
  'personalities:list': { request: undefined; response: PersonalityListItem[] };
  'keychain:set': { request: { key: string; value: string }; response: { success: boolean } };
  'keychain:get': { request: { key: string }; response: { value: string | null } };
  'health:check': { request: { port: number }; response: { healthy: boolean } };
  'theme:get': { request: undefined; response: 'dark' | 'light' };
}

export type IpcChannel = keyof IpcContract;
