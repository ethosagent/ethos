import type { Contract } from '@ethosagent/web-contracts';
import type { ContractRouterClient } from '@orpc/contract';
import type { EventStreamSubscription } from './stream';

/** @experimental -- third parties can implement this without a support promise. */
export interface Dispatcher {
  readonly rpc: ContractRouterClient<Contract>;
  stream(
    sessionId: string,
    opts: {
      sinceSeq?: number;
      signal?: AbortSignal;
      onEvent: (event: import('@ethosagent/web-contracts').SseEvent, seq: number) => void;
      onError?: (err: unknown) => void;
    },
  ): EventStreamSubscription;
}
