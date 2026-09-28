import { describe, expect, it } from 'vitest';

describe('ToolContext shape', () => {
  it('has llm field in the type definition', () => {
    // Compile-time assertion: if llm is removed from ToolContext, this file
    // will fail to typecheck. The runtime assertion is a placeholder.
    type AssertHasLlm = import('../tool').ToolContext extends { llm?: unknown } ? true : never;
    const _check: AssertHasLlm = true;
    expect(_check).toBe(true);
  });
});

// plan personality-memory-boundary G1 — `roomAudience` and `initiator` are
// optional ToolContext fields (Tool contract, two-maintainer sign-off). These
// pin the exact types, not just the key: `Equal` fails typecheck if either is
// removed, made required, or widened, and the `ToolExecuteRequest` mirror must
// match so the transport hop cannot drop or reshape them.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Ctx = import('../tool').ToolContext;
type Req = import('../tool').ToolExecuteRequest;

describe('ToolContext audience fields', () => {
  it('roomAudience is optional and typed private | shared, mirrored on the request', () => {
    const exact: Equal<Ctx['roomAudience'], 'private' | 'shared' | undefined> = true;
    const optional: Equal<
      Pick<Ctx, 'roomAudience'>,
      { roomAudience?: 'private' | 'shared' }
    > = true;
    const mirrored: Equal<Req['roomAudience'], Ctx['roomAudience']> = true;
    expect([exact, optional, mirrored]).toEqual([true, true, true]);
  });

  it('initiator is optional and typed user | system, mirrored on the request', () => {
    const exact: Equal<Ctx['initiator'], 'user' | 'system' | undefined> = true;
    const optional: Equal<Pick<Ctx, 'initiator'>, { initiator?: 'user' | 'system' }> = true;
    const mirrored: Equal<Req['initiator'], Ctx['initiator']> = true;
    expect([exact, optional, mirrored]).toEqual([true, true, true]);
  });
});
