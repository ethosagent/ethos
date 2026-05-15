import { ethosDir } from './config';

declare const __ETHOS_VERSION__: string;
const ETHOS_VERSION =
  typeof __ETHOS_VERSION__ === 'string' ? __ETHOS_VERSION__ : (process.env.ETHOS_VERSION ?? 'dev');

export interface VersionInfo {
  name: string;
  version: string;
  node: string;
  platform: string;
  arch: string;
  supportedProviders: string[];
  supportedChannels: string[];
  managedMode: boolean;
  ethosDir: string;
}

export function buildVersionInfo(): VersionInfo {
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
