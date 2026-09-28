import { os } from '../../../rpc/context';

// Web `/undo` — the procedure `packages/web-contracts` declares as
// `sessions.undoTurns`. Removes whole turns (UBP-023).
export const sessionsUndoTurns = os.sessions.undoTurns.handler(({ input, context }) =>
  context.sessions.undoTurns(input.id, input.n),
);
