import { contract } from '@ethosagent/web-contracts';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { EventStream } from './stream';
export class HttpDispatcher {
  rpc;
  baseUrl;
  apiKey;
  constructor(opts) {
    const base = opts.baseUrl.replace(/\/+$/, '');
    this.baseUrl = base;
    this.apiKey = opts.apiKey;
    const fetchFn = opts.fetch ?? globalThis.fetch;
    const link = new RPCLink({
      url: `${base}/rpc`,
      ...(this.apiKey
        ? { headers: () => ({ Authorization: `Bearer ${this.apiKey}` }) }
        : {
            fetch: (input, init) => fetchFn(input, { ...init, credentials: 'include' }),
          }),
    });
    this.rpc = createORPCClient(link);
    void contract;
  }
  stream(sessionId, opts) {
    return EventStream({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      sessionId,
      sinceSeq: opts.sinceSeq,
      signal: opts.signal,
      onEvent: opts.onEvent,
      onError: opts.onError,
    });
  }
}
