import { describe, expect, it } from 'vitest';
import { readBootSources } from './boot-sources';

// `ethos serve` hands the loop's `initiativeRuntime.enablement` to `createWebApi`
// (via `buildServeWebApi`) so a Settings save of the initiatives block calls
// `enablement.reload` and the toggle applies at once. The `boot` web-api path
// builds through the same `buildServeWebApi`; dropping the option there leaves
// the toggle stored but not applied until restart. `runBoot` is a long-running
// composition root, so this is asserted against source, like
// serve-goals-wiring.test.ts.

describe('boot.ts — initiative enablement forwarding', () => {
  it('hands the shared loop’s enablement to buildServeWebApi', () => {
    expect(readBootSources()).toContain(
      'initiativeEnablement: shared.initiativeRuntime.enablement,',
    );
  });
});
