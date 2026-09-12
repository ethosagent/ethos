// The approval outbox is WIRED, in both gateway roots
// (plan/phases/trust-before-reach.md, O-T4/O-T6 and O-D8).
//
// Everything else about Part 2 can be unit-tested. This cannot: the gate is
// built only when `ComposeToolsDeps.outbox` is supplied, and for the whole of
// wave 1 nothing supplied it — the policy was enforced by code that was never
// constructed. The failure mode is silent in exactly the way that matters: a
// personality with `approve_before_send: true` publishes, and every test of the
// gate itself still passes.
//
// So this is a source scan, the shape `no-raw-fs.test.ts` and
// `idle-watcher-wiring.test.ts` already use here. It asserts the construction
// is on the boot path of BOTH roots, that every loop that can run a turn gets
// it, that the dispatcher starts after the adapters and stops on shutdown, and
// that the Gateway is given the binding re-check without which
// `deliverPublication` refuses everything.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMMANDS = join(import.meta.dirname, '..', 'commands');
const gateway = readFileSync(join(COMMANDS, 'gateway.ts'), 'utf8');
const boot = readFileSync(join(COMMANDS, 'boot.ts'), 'utf8');

const ROOTS: ReadonlyArray<readonly [string, string]> = [
  ['ethos gateway start', gateway],
  ['ethos boot', boot],
];

describe.each(ROOTS)('%s', (_label, source) => {
  it('constructs the one shared outbox runtime', () => {
    expect(source).toContain('createOutboxRuntime({');
    expect(source).toContain("from '../lib/outbox-wiring'");
  });

  it('hands the gate to its system loop and to every bot loop', () => {
    expect(source).toContain('outbox: outbox.wiring');
    expect(source).toContain('outbox.wiring,');
  });

  it('gives the Gateway the botKey-level binding re-check', () => {
    // Absent, `deliverPublication` refuses EVERY publication — approvals would
    // queue with nothing able to deliver them.
    expect(source).toContain('publicationSpeaksFor: botSpeakers.speaksFor');
  });

  it('starts the dispatcher only after the adapters are up', () => {
    const adaptersUp = source.indexOf('adapters.map((a) => a.start())');
    const dispatcherUp = source.indexOf('void outboxDispatcher.start();');
    expect(adaptersUp).toBeGreaterThan(-1);
    expect(dispatcherUp).toBeGreaterThan(adaptersUp);
  });

  it('stops the dispatcher and closes the store on shutdown', () => {
    expect(source).toContain('outboxDispatcher.stop()');
    expect(source).toContain('outbox.close()');
  });

  it('counts approved-but-unsent publications as busy for the idle watcher', () => {
    expect(source).toContain('outboxPending: outbox.pendingPublications');
  });

  it('gives the outbox the audit sink, so a Telegram tap lands in `ethos audit decisions`', () => {
    // X-D11. `OutboxService`'s sink is optional, and absent it writes nothing
    // and still decides: a tap on the card approves a publication and leaves no
    // row. Silent in the same way the gate itself was — the web path has its
    // own sink, so every audit test of the service still passes.
    const call = source.slice(source.indexOf('createOutboxRuntime({'));
    expect(call.slice(0, call.indexOf('\n  });'))).toContain(
      'recordSafetyApproval: (opts) => getEthosObservability().recordSafetyApproval(opts)',
    );
  });
});

describe('ethos boot hot-added bots', () => {
  it('gates a bot added without a restart, exactly like a cold-booted one', () => {
    // `buildGatewayBots` takes the outbox as its last argument. Every call in
    // this file must pass it: a hot-add path that does not is a bot whose
    // gated personality publishes unreviewed until the next restart.
    const calls = boot.split('await buildGatewayBots(').slice(1);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call.slice(0, call.indexOf(');'))).toContain('outbox.wiring');
    }
  });
});
