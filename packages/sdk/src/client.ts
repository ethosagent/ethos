import { type Contract, contract } from '@ethosagent/web-contracts';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';

export interface EthosClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

export class EthosClient {
  readonly rpc: ContractRouterClient<Contract>;
  readonly baseUrl: string;

  private readonly apiKey: string | undefined;

  constructor(opts: EthosClientOptions) {
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
}
