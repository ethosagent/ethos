import { ethosDir } from './config';

const ETHOS_VERSION =
  typeof __ETHOS_VERSION__ === 'string' ? __ETHOS_VERSION__ : (process.env.ETHOS_VERSION ?? 'dev');
export function buildVersionInfo() {
  return {
    name: '@ethosagent/cli',
    version: ETHOS_VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    supportedProviders: [
      'anthropic',
      'azure',
      'openai',
      'openrouter',
      'gemini',
      'groq',
      'deepseek',
      'ollama',
    ],
    supportedChannels: ['telegram', 'slack', 'discord', 'email'],
    managedMode: process.env.ETHOS_MANAGED === '1',
    ethosDir: ethosDir(),
  };
}
