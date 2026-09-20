import { type Contract, contract } from '@ethosagent/web-contracts';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import type { Dispatcher } from './dispatcher';
import { EventStream, type EventStreamSubscription } from './stream';

export interface HttpDispatcherOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

export class HttpDispatcher implements Dispatcher {
  readonly rpc: ContractRouterClient<Contract>;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(opts: HttpDispatcherOptions) {
    const base = opts.baseUrl.replace(/\/+$/, '');
    this.baseUrl = base;
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetch ?? globalThis.fetch;

    // Both branches must thread `fetchFn` — previously only the cookie
    // branch did, so an injected `fetch` (e.g. `expo/fetch`) was silently
    // ignored for every bearer client. Pinned by
    // `__tests__/http-dispatcher.test.ts`.
    const link = new RPCLink({
      url: `${base}/rpc`,
      ...(this.apiKey
        ? {
            headers: () => ({ Authorization: `Bearer ${this.apiKey}` }),
            fetch: this.fetchFn,
          }
        : {
            fetch: (input, init) =>
              this.fetchFn(input, { ...init, credentials: 'include' as RequestCredentials }),
          }),
    });

    this.rpc = createORPCClient(link);

    void contract;
  }

  stream(
    sessionId: string,
    opts: {
      sinceSeq?: number;
      signal?: AbortSignal;
      onEvent: (event: import('@ethosagent/web-contracts').SseEvent, seq: number) => void;
      onError?: (err: unknown) => void;
      onGap?: () => void;
    },
  ): EventStreamSubscription {
    return EventStream({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      sessionId,
      fetch: this.fetchFn,
      sinceSeq: opts.sinceSeq,
      signal: opts.signal,
      onEvent: opts.onEvent,
      onError: opts.onError,
      onGap: opts.onGap,
    });
  }
}
