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

  constructor(opts: HttpDispatcherOptions) {
    const base = opts.baseUrl.replace(/\/+$/, '');
    this.baseUrl = base;
    this.apiKey = opts.apiKey;
    const fetchFn = opts.fetch ?? globalThis.fetch;

    const link = new RPCLink({
      url: `${base}/rpc`,
      ...(this.apiKey
        ? { headers: () => ({ Authorization: `Bearer ${this.apiKey}` }) }
        : {
            fetch: (input, init) =>
              fetchFn(input, { ...init, credentials: 'include' as RequestCredentials }),
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
    },
  ): EventStreamSubscription {
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
