// FW-9 — pure resolver for busy-input dispatch. Kept separate from chat.ts
// so the contract is testable without spinning up readline.

export type BusyMode = 'interrupt' | 'queue' | 'steer';

export interface BusyDispatchInput {
  mode: BusyMode;
  input: string;
  /** Iterations the active turn has completed. `steer` falls back to `queue`
   *  when this is 0 (no tool_results yet to attach the steer to). */
  iterationsThisTurn: number;
}

export type BusyDispatchAction =
  | { action: 'interrupt'; queueInput: string }
  | { action: 'queue'; queueInput: string }
  | { action: 'steer'; steerText: string };

export function resolveBusyDispatch(input: BusyDispatchInput): BusyDispatchAction {
  if (input.mode === 'interrupt') {
    return { action: 'interrupt', queueInput: input.input };
  }
  if (input.mode === 'queue') {
    return { action: 'queue', queueInput: input.input };
  }
  // mode === 'steer'
  if (input.iterationsThisTurn === 0) {
    return { action: 'queue', queueInput: input.input };
  }
  return { action: 'steer', steerText: input.input };
}
