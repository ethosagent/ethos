import { createEthosClient } from '@ethosagent/sdk';

// Safe to expose in client bundle — this is a URL, not a secret.
export const baseUrl = process.env.NEXT_PUBLIC_ETHOS_BASE_URL ?? 'http://localhost:3000';

// Server-side only — called from /api/* routes, never from client components.
export const ethos = createEthosClient({
  baseUrl: process.env.ETHOS_BASE_URL ?? 'http://localhost:3000',
  apiKey: process.env.ETHOS_API_KEY ?? '',
});
