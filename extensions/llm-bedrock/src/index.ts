export { BedrockProvider, type BedrockProviderConfig } from './provider';
export { type SigV4Config, SigV4Signer } from './sigv4';
export { type BedrockTransportConfig, streamBedrockConverse } from './transport';

// ---------------------------------------------------------------------------
// First-party plugin activation
// ---------------------------------------------------------------------------

import type { EthosPluginApi, LLMProviderFactory } from '@ethosagent/plugin-sdk';
import { BedrockProvider } from './provider';

export const PROVIDER_CONTRACT_MAJOR = 3;

export const bedrockFactory: LLMProviderFactory = async ({ config: cfg, secrets }) => {
  const region = (cfg.region as string) ?? 'us-east-1';
  const accessKeyId =
    (await secrets.get('providers/bedrock/accessKeyId')) ?? (cfg.accessKeyId as string);
  const secretAccessKey =
    (await secrets.get('providers/bedrock/secretAccessKey')) ?? (cfg.secretAccessKey as string);
  const sessionToken =
    (await secrets.get('providers/bedrock/sessionToken')) ??
    (cfg.sessionToken as string | undefined);
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Bedrock provider requires accessKeyId and secretAccessKey credentials');
  }
  return new BedrockProvider({
    region,
    modelId: cfg.model as string,
    sigv4: { region, accessKeyId, secretAccessKey, sessionToken },
  });
};

export function activate(api: EthosPluginApi): void {
  api.registerLLMProvider('bedrock', bedrockFactory);
}
