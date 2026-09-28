import type { ConfigOnlyProviderManifest } from '@ethosagent/types';

export const BUILTIN_CONFIG_PROVIDERS: ConfigOnlyProviderManifest[] = [
  {
    id: 'together',
    name: 'Together AI',
    transport: 'openai-chat-completions',
    baseUrl: 'https://api.together.xyz/v1',
    auth: {
      location: 'header',
      name: 'Authorization',
      scheme: 'bearer',
      secretRef: 'providers/together/apiKey',
    },
    capabilities: {
      streaming: true,
      toolCalling: true,
      parallelToolCalls: true,
      visionImages: true,
      thinking: false,
      promptCaching: false,
      systemPromptStyle: 'system-role',
      tokenCounting: 'estimated',
      contractVersion: 1,
    },
    // Both Llama 4 models this listed left Together serverless in 2026; these
    // two are on docs.together.ai/docs/serverless-models (2026-09-28).
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'openai/gpt-oss-120b'],
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    transport: 'openai-chat-completions',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    auth: {
      location: 'header',
      name: 'Authorization',
      scheme: 'bearer',
      secretRef: 'providers/fireworks/apiKey',
    },
    capabilities: {
      streaming: true,
      toolCalling: true,
      visionImages: true,
      thinking: false,
      promptCaching: false,
      systemPromptStyle: 'system-role',
      tokenCounting: 'estimated',
      contractVersion: 1,
    },
    models: ['accounts/fireworks/models/llama4-scout-instruct-basic'],
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    transport: 'openai-chat-completions',
    baseUrl: 'https://api.mistral.ai/v1',
    auth: {
      location: 'header',
      name: 'Authorization',
      scheme: 'bearer',
      secretRef: 'providers/mistral/apiKey',
    },
    capabilities: {
      streaming: true,
      toolCalling: true,
      parallelToolCalls: true,
      thinking: false,
      promptCaching: false,
      systemPromptStyle: 'system-role',
      tokenCounting: 'estimated',
      contractVersion: 1,
    },
    defaultModel: 'mistral-large-latest',
  },
];
