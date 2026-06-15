import { EthosClient, HttpDispatcher } from '@ethosagent/sdk';

const apiBase =
  import.meta.env.VITE_API_URL ?? (typeof window !== 'undefined' ? window.location.origin : '');

export let client = new EthosClient(new HttpDispatcher({ baseUrl: apiBase }));
export let rpc = client.rpc;

/**
 * Re-initialize the SDK client for remote mode.
 * Call from app bootstrap after resolving `window.ethos.connection.get()`.
 */
export function reinitializeClient(baseUrl: string, bearerToken?: string): void {
  client = new EthosClient(
    new HttpDispatcher({ baseUrl, ...(bearerToken ? { apiKey: bearerToken } : {}) }),
  );
  rpc = client.rpc;
}
