import { createEthosClient } from '@ethosagent/sdk';

// Exported so EventStream subscribers (e.g. ChatPanel) can reuse the same
// base URL without re-reading process.env at every call site.
export const baseUrl = process.env.NEXT_PUBLIC_ETHOS_BASE_URL ?? 'http://localhost:3000';

export const ethos = createEthosClient({
  baseUrl,
  apiKey: process.env.NEXT_PUBLIC_ETHOS_API_KEY ?? '',
});
