import { describe, expect, it } from 'vitest';

// Imported at collection, where no timeout applies. The module pulls in
// `@ethosagent/sdk` and the `@ethosagent/web-contracts` schemas behind it;
// imported inside the test, that cold transform counted against the test's 15s
// budget, which a parallel run can exhaust.
const mod = await import('../rpc');

describe('rpc', () => {
  it('exports client and rpc', () => {
    expect(mod.client).toBeDefined();
    expect(mod.rpc).toBeDefined();
  });
});
