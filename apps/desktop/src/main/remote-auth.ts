import { session } from 'electron';
import { getKeychainValue } from './keychain';
import { remoteOrigin, withBearerToken } from './remote-auth-helpers';
import { store } from './store';

// In remote mode the renderer talks straight to the remote web-api, but the
// auth token lives in the OS keychain and is deliberately never exposed to
// the renderer. This hook injects `Authorization: Bearer <token>` into every
// renderer request to the remote origin — including EventSource connections,
// which cannot set headers from JS. Local mode keeps the existing cookie
// flow; no listener is registered.
//
// Call on startup and again after `connection:set` so changes take effect
// without a restart. Electron keeps only one onBeforeSendHeaders listener
// per session, so re-registering replaces the previous one.

export async function syncRemoteAuth(): Promise<void> {
  const mode = store.get('connectionMode') ?? 'local';
  const url = store.get('remoteUrl');
  const origin = mode === 'remote' && url ? remoteOrigin(url) : null;
  const token = origin ? await getKeychainValue('remote-token') : null;
  const { webRequest } = session.defaultSession;
  if (!origin || !token) {
    webRequest.onBeforeSendHeaders(null);
    return;
  }
  webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
    callback({ requestHeaders: withBearerToken(details.requestHeaders, token) });
  });
}
