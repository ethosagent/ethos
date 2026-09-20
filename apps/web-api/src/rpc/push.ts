import { EthosError } from '@ethosagent/types';
import { os } from './context';

// The push namespace (mobile-app plan S5, S13(c)). A device row belongs to the
// API key that registered it, taken from the request's resolved key row
// (`_apiKey`, set by `dualAuth`) — never from the input. So:
//   - register    bearer only. A cookie session has no key to bind a phone to,
//                 so it is FORBIDDEN rather than silently storing an orphan.
//   - unregister  bearer: the caller's own row for that token. Cookie (the
//                 operator): that token under every key.
//   - test        bearer: the caller's own devices; an `apiKeyId` it sends is
//                 ignored. Cookie: the named key's devices, or all of them.
//   - listDevices cookie-only in `SCOPE_MAP`; rows carry a token TAIL only.
// `push.transport: none` leaves `context.push.dispatcher` undefined: register
// stores nothing and says so, test reports it — neither is an error.

const TOKEN_TAIL = 6;

/** The caller's key id when the request authenticated by bearer. Same
 *  `_authMethod`/`_apiKey` read as `rpc/tools.ts`. */
function bearerKeyId(context: object): string | undefined {
  const c = context as { _authMethod?: unknown; _apiKey?: { id?: unknown } };
  return c._authMethod === 'bearer' && typeof c._apiKey?.id === 'string' ? c._apiKey.id : undefined;
}

function pushUnavailable(): EthosError {
  return new EthosError({
    code: 'FORBIDDEN',
    cause: 'Push needs an API-key store, and this server has none.',
    action: 'Run `ethos serve` to register a phone for push.',
  });
}

export const pushRouter = {
  register: os.push.register.handler(async ({ input, context }) => {
    const apiKeyId = bearerKeyId(context);
    if (!apiKeyId) {
      throw new EthosError({
        code: 'FORBIDDEN',
        cause: 'push.register binds a device to the API key that calls it.',
        action: "Call it with the phone's API key (bearer), not a browser session.",
      });
    }
    if (!context.push) throw pushUnavailable();
    if (!context.push.dispatcher) return { registered: false, transport: 'none' as const };
    context.push.devices.register({ apiKeyId, ...input });
    return { registered: true, transport: 'expo' as const };
  }),

  unregister: os.push.unregister.handler(async ({ input, context }) => {
    if (!context.push) throw pushUnavailable();
    return { removed: context.push.devices.unregister(input.expoPushToken, bearerKeyId(context)) };
  }),

  test: os.push.test.handler(async ({ input, context }) => {
    if (!context.push) throw pushUnavailable();
    if (!context.push.dispatcher) {
      return { ok: false as const, error: 'push is off on this server (push.transport: none)' };
    }
    const bearer = bearerKeyId(context);
    return context.push.dispatcher.test(bearer ?? input.apiKeyId);
  }),

  listDevices: os.push.listDevices.handler(async ({ context }) => {
    return (context.push?.devices.listWithKeys() ?? []).map((d) => ({
      apiKeyId: d.apiKeyId,
      keyName: d.keyName,
      keyPrefix: d.keyPrefix,
      platform: d.platform,
      appVersion: d.appVersion,
      tokenTail: d.expoPushToken.slice(-TOKEN_TAIL),
      lastRegisteredAt: d.lastRegisteredAt,
    }));
  }),
};
