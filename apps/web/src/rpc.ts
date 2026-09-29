import { EthosClient, HttpDispatcher } from '@ethosagent/sdk';
import { reportAuthNetworkError, reportAuthResponse } from './lib/auth/auth-bridge';

const apiBase =
  import.meta.env.VITE_API_URL ?? (typeof window !== 'undefined' ? window.location.origin : '');

// Every /rpc call flows through this fetch so the AuthGate learns about dead
// sessions and dead backends from the transport itself (web-auth-bootstrap
// D9): a 401 response raises `unauthorized` (the gate shows the lock screen),
// a rejected fetch raises `unreachable` (the gate shows reconnecting), and
// any response at all clears `unreachable`. A 401 can never read as
// "offline", because a 401 IS a response.
const gateAwareFetch: typeof globalThis.fetch = async (input, init) => {
  let res: Response;
  try {
    res = await globalThis.fetch(input, init);
  } catch (err) {
    reportAuthNetworkError();
    throw err;
  }
  reportAuthResponse(res.status);
  return res;
};

export const client = new EthosClient(
  new HttpDispatcher({ baseUrl: apiBase, fetch: gateAwareFetch }),
);
export const rpc = client.rpc;
