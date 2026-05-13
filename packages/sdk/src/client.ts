import type { Contract } from '@ethosagent/web-contracts';
import type { ContractRouterClient } from '@orpc/contract';
import type { Dispatcher } from './dispatcher';

export class EthosClient {
  readonly rpc: ContractRouterClient<Contract>;
  private readonly dispatcher: Dispatcher;

  constructor(dispatcher: Dispatcher) {
    this.dispatcher = dispatcher;
    this.rpc = dispatcher.rpc;
  }

  stream(
    ...args: Parameters<Dispatcher['stream']>
  ): ReturnType<Dispatcher['stream']> {
    return this.dispatcher.stream(...args);
  }
}
