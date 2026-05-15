import { EthosClient } from '@ethosagent/sdk';

export const ethos = new EthosClient({
  baseUrl: process.env.NEXT_PUBLIC_ETHOS_BASE_URL ?? 'http://localhost:3000',
  apiKey: process.env.NEXT_PUBLIC_ETHOS_API_KEY ?? '',
});
