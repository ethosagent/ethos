import { EthosClient } from '@ethosagent/sdk';

const apiBase =
  import.meta.env.VITE_API_URL ?? (typeof window !== 'undefined' ? window.location.origin : '');

const client = new EthosClient({ baseUrl: apiBase });

export const rpc = client.rpc;
