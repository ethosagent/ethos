// P8 delegation containment — the phase's security gate (plan §5 P8 / §17).
//
// Two independent bounds, each with its own attack:
//   - signed in-envelope call depth, rejected at ≥ MAX (a plain header is ignored)
//   - a global per-trace fan-out budget (the backstop against a peer lying about depth)

import { describe, expect, it } from 'vitest';
import { generateEd25519, rawPublicKeyFromPem, signStruct } from '../crypto';
import {
  A2A_DELEGATION_CONTEXT,
  A2aDelegationGuard,
  buildDelegationCredentials,
  signDelegation,
} from '../delegation';

function makeKey() {
  const { privateKeyPem } = generateEd25519();
  return { privateKeyPem, publicKey: rawPublicKeyFromPem(privateKeyPem) };
}

describe('P8 — call-depth ceiling (A→B→A halts at MAX_DEPTH)', () => {
  it('admits depths below MAX and rejects a signed depth ≥ MAX', () => {
    const guard = new A2aDelegationGuard({ maxDepth: 3 });
    const caller = makeKey();
    const traceId = 'trace-xyz';

    for (const depth of [0, 1, 2]) {
      const creds = buildDelegationCredentials(traceId, depth, caller.privateKeyPem);
      const admit = guard.admitInbound(creds, caller.publicKey);
      expect(admit.ok).toBe(true);
      if (admit.ok) expect(admit.depth).toBe(depth);
    }

    // The MAX-depth hop is the A→B→A chain terminus — rejected.
    const atMax = buildDelegationCredentials(traceId, 3, caller.privateKeyPem);
    const rejected = guard.admitInbound(atMax, caller.publicKey);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toMatch(/depth/);
  });

  it('treats an absent envelope as a fresh top-level call (depth 0, new trace)', () => {
    const guard = new A2aDelegationGuard();
    const caller = makeKey();
    const admit = guard.admitInbound(
      { traceId: null, depth: null, signature: null },
      caller.publicKey,
    );
    expect(admit.ok).toBe(true);
    if (admit.ok) {
      expect(admit.depth).toBe(0);
      expect(admit.traceId).toBeTruthy();
    }
  });
});

describe('P8 — spoofed depth is ignored (only the SIGNED value counts)', () => {
  it('rejects a request whose SIGNED depth is MAX even though a plain depth:0 accompanies it', () => {
    const guard = new A2aDelegationGuard({ maxDepth: 3 });
    const caller = makeKey();

    // The attacker signs depth = MAX honestly, but pairs it with a plain
    // header claiming depth 0. The guard only ever reads the SIGNED depth (the
    // credentials carry the value covered by the signature); the plain 0 never
    // reaches the guard, so the request is rejected on the signed MAX.
    const signedAtMax = buildDelegationCredentials('trace-spoof', 3, caller.privateKeyPem);
    const admit = guard.admitInbound(signedAtMax, caller.publicKey);
    expect(admit.ok).toBe(false);
  });

  it('rejects a mismatched signature (depth echoed as 0 but signature is over MAX)', () => {
    const guard = new A2aDelegationGuard({ maxDepth: 3 });
    const caller = makeKey();
    // Attacker tries to LOWER the echoed depth to 0 while reusing a signature
    // that was made over depth 3 → the reconstructed struct (depth 0) does not
    // match the signature → rejected as an invalid envelope.
    const sigOverMax = signDelegation('trace-tamper', 3, caller.privateKeyPem);
    const admit = guard.admitInbound(
      { traceId: 'trace-tamper', depth: 0, signature: sigOverMax },
      caller.publicKey,
    );
    expect(admit.ok).toBe(false);
    if (!admit.ok) expect(admit.reason).toMatch(/signature/);
  });

  it('rejects an envelope signed by the WRONG key', () => {
    const guard = new A2aDelegationGuard({ maxDepth: 3 });
    const caller = makeKey();
    const attacker = makeKey();
    // depth 0 is under the ceiling, but the signature is not the caller's.
    const creds = buildDelegationCredentials('trace-1', 0, attacker.privateKeyPem);
    const admit = guard.admitInbound(creds, caller.publicKey);
    expect(admit.ok).toBe(false);
  });

  it('binds the domain-separation context (a bare/mis-contexted signature fails)', () => {
    const guard = new A2aDelegationGuard({ maxDepth: 3 });
    const caller = makeKey();
    // Sign the trace/depth WITHOUT the delegation context discriminator.
    const badSig = signStruct(
      { context: 'not-a2a-delegation', trace_id: 'trace-1', depth: 0 },
      caller.privateKeyPem,
    );
    const admit = guard.admitInbound(
      { traceId: 'trace-1', depth: 0, signature: badSig },
      caller.publicKey,
    );
    expect(admit.ok).toBe(false);
    // Sanity: the correctly-contexted struct uses the exported constant.
    expect(A2A_DELEGATION_CONTEXT).toBe('a2a-delegation');
  });
});

describe('P8 — global per-trace fan-out budget', () => {
  it('permits exactly `budget` outbound calls per trace, then rejects the (budget+1)-th', () => {
    const guard = new A2aDelegationGuard({ fanOutBudget: 4 });
    const caller = makeKey();
    const admit = guard.admitInbound(
      buildDelegationCredentials('trace-fanout', 0, caller.privateKeyPem),
      caller.publicKey,
    );
    expect(admit.ok).toBe(true);
    const traceId = admit.ok ? admit.traceId : '';

    for (let i = 0; i < 4; i++) {
      expect(guard.reserveOutbound(traceId)).toBe(true);
    }
    // The (budget+1)-th outbound call is denied — depth-limited but wide fan-out
    // cannot amplify past the budget.
    expect(guard.reserveOutbound(traceId)).toBe(false);
  });

  it('tracks fan-out independently per trace id', () => {
    const guard = new A2aDelegationGuard({ fanOutBudget: 1 });
    expect(guard.reserveOutbound('trace-a')).toBe(true);
    expect(guard.reserveOutbound('trace-a')).toBe(false);
    // A different trace has its own budget.
    expect(guard.reserveOutbound('trace-b')).toBe(true);
  });

  it('frees a trace budget on releaseTrace', () => {
    const guard = new A2aDelegationGuard({ fanOutBudget: 1 });
    expect(guard.reserveOutbound('trace-a')).toBe(true);
    expect(guard.reserveOutbound('trace-a')).toBe(false);
    guard.releaseTrace('trace-a');
    expect(guard.reserveOutbound('trace-a')).toBe(true);
  });
});
