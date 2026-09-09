import { generateKeyPairSync } from 'node:crypto';
import type { ToolContext } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Shared fixtures. The RSA key is GENERATED at import time — a throwaway pair
// that exists only for this process, never a real credential (§12).
// ---------------------------------------------------------------------------

export const { publicKey: TEST_PUBLIC_KEY, privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync(
  'rsa',
  {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  },
);

/** A second key with the SAME client_email — the rotation shape D31 is about. */
export const { privateKey: TEST_PRIVATE_KEY_2 } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

export const CLIENT_EMAIL = 'ethos-gsc@example-project.iam.gserviceaccount.com';

export function serviceAccountJson(
  overrides: Record<string, unknown> = {},
  privateKey = TEST_PRIVATE_KEY,
): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'example-project',
    client_email: CLIENT_EMAIL,
    private_key: privateKey,
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  });
}

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SITES_URL = 'https://searchconsole.googleapis.com/webmasters/v3/sites';

export interface RecordedCall {
  url: string;
  init?: RequestInit;
}

export type RouteHandler = (call: RecordedCall) => Response;

/** A `scopedFetch` stub that answers the mint with a fixed token and routes
 *  everything else to `apiHandler`. Records every call. */
export function makeRouter(apiHandler: RouteHandler, tokenHandler?: RouteHandler) {
  const calls: RecordedCall[] = [];
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const call: RecordedCall = { url: typeof url === 'string' ? url : url.toString(), init };
    calls.push(call);
    if (call.url.startsWith(TOKEN_URL)) {
      return (
        tokenHandler?.(call) ??
        Response.json({ access_token: 'test-access-token', expires_in: 3600 })
      );
    }
    return apiHandler(call);
  };
  return { scopedFetch: { fetch }, calls };
}

export function makeCtx(
  scopedFetch: { fetch: (url: string | URL, init?: RequestInit) => Promise<Response> },
  secrets: { get: (ref: string) => Promise<string> } = {
    get: async () => serviceAccountJson(),
  },
): ToolContext {
  return {
    sessionId: 'test',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    secretsResolver: secrets,
    scopedFetch,
  };
}
