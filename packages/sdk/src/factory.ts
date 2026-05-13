import { EthosClient } from './client';
import { EthosError } from './error';
import { HttpDispatcher } from './http-dispatcher';

export interface CreateEthosClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch: typeof globalThis.fetch;
}

export function createEthosClient(opts?: Partial<CreateEthosClientOptions>): EthosClient {
  const baseUrl = opts?.baseUrl ?? process.env.ETHOS_BASE_URL ?? 'http://localhost:3000';
  const apiKey = opts?.apiKey ?? process.env.ETHOS_API_KEY;

  // In Node (no window), missing API key is an error
  if (!apiKey && typeof globalThis.window === 'undefined') {
    throw new EthosError({
      code: 'NO_API_KEY',
      message: 'No API key provided.',
      action: 'Set ETHOS_API_KEY in your environment or pass apiKey to createEthosClient().',
    });
  }

  const dispatcher = new HttpDispatcher({ baseUrl, apiKey, fetch: opts?.fetch });
  return new EthosClient(dispatcher);
}
