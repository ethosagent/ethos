import { type Contract, contract } from '@ethosagent/web-contracts';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';

export interface EthosClientOptions {
  baseUrl: string;
  apiKey: string;
}

export class EthosClient {
  readonly rpc: ContractRouterClient<Contract>;
  readonly baseUrl: string;

  private readonly apiKey: string;

  constructor(opts: EthosClientOptions) {
    const base = opts.baseUrl.replace(/\/+$/, '');
    this.baseUrl = base;
    this.apiKey = opts.apiKey;

    const link = new RPCLink({
      url: `${base}/rpc`,
      headers: () => ({ Authorization: `Bearer ${this.apiKey}` }),
    });

    this.rpc = createORPCClient(link);

    void contract;
  }
}
