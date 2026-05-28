// FW-9 — pure resolver for busy-input dispatch. Kept separate from chat.ts
// so the contract is testable without spinning up readline.
export function resolveBusyDispatch(input) {
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
