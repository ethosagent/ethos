// The two commands that own platform adapters arm the delivery ledger's
// periodic sweep (plan openclaw-2026.9.6-gaps R1). Before this the ledger was
// swept once, at boot, so a reply refused by a transient platform error on a
// long-running gateway stayed `pending` until the next restart.
//
// Source text, the same idiom as `gateway-unattended-gate-wiring.test.ts`:
// `runGatewayStart` and `runBoot` boot whole processes and cannot be invoked
// from a unit test. The timer's behaviour is pinned in
// extensions/gateway/src/__tests__/delivery-ledger.test.ts ('periodic
// delivery sweep').

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');

describe('delivery-ledger periodic sweep wiring', () => {
  for (const file of ['gateway.ts', 'boot.ts']) {
    it(`${file} arms gateway.startDeliverySweep() after the adapters start`, async () => {
      const src = await readFile(join(ROOT, 'apps/ethos/src/commands', file), 'utf8');
      const started = src.indexOf('await Promise.all(adapters.map((a) => a.start()));');
      const armed = src.indexOf('gateway.startDeliverySweep();');
      expect(started).toBeGreaterThan(-1);
      expect(armed).toBeGreaterThan(started);
    });
  }
});
