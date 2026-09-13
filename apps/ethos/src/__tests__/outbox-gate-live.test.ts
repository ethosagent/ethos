// The approval outbox is WIRED in every root that can reach a channel
// (plan/phases/trust-before-reach.md, O-T4/O-T6 and O-D8) — the two gateway
// roots in full, `ethos serve` on the proposal side — and every root left
// unwired has no path to a channel to gate.
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

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI_ROOT = join(import.meta.dirname, '..');
const COMMANDS = join(CLI_ROOT, 'commands');
const read = (name: string) => readFileSync(join(COMMANDS, name), 'utf8');
const gateway = read('gateway.ts');
const boot = read('boot.ts');
const serve = read('serve.ts');

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

describe('ethos serve — the proposal side, and nothing that delivers', () => {
  it('constructs it from the one shared module, with no dispatcher and no card glue', () => {
    expect(serve).toContain('createOutboxProposalSide({');
    expect(serve).toContain("from '../lib/outbox-wiring'");
    // Delivery needs adapters; serve holds none (O-D8/O-D9).
    expect(serve).not.toContain('createOutboxDispatcher');
    expect(serve).not.toContain('wireOutboxCardAdapters');
  });

  it('hands the gate to every serve loop that registers the watcher tools', () => {
    // The watcher tools are serve's path to a channel: a stored `deliver` is
    // sent by a gateway on this machine. A loop given them without the outbox
    // is a gated personality creating an unreviewed publication.
    const calls = serve.match(/serveLoopOptions\(\{[^}]*\}\)/g) ?? [];
    const withWatchers = calls.filter((call) => call.includes('watcherManager'));
    expect(withWatchers.length).toBeGreaterThanOrEqual(2);
    for (const call of withWatchers) expect(call).toContain('outbox');
    expect(serve).toContain('const outbox = outboxSide.wiring;');
    expect(serve).toContain('...(opts.outbox ? { outbox: opts.outbox } : {}),');
  });

  it('gives the outbox the audit sink', () => {
    const call = serve.slice(serve.indexOf('createOutboxProposalSide({'));
    expect(call.slice(0, call.indexOf('\n  });'))).toContain(
      'recordSafetyApproval: (o) => getEthosObservability().recordSafetyApproval(o)',
    );
  });

  it('drains reviews before the loop is disposed, and closes the store', () => {
    const drain = serve.indexOf('await outboxSide.drain()');
    expect(drain).toBeGreaterThan(-1);
    expect(drain).toBeLessThan(serve.indexOf("['agent loop', disposeLoop]"));
    expect(serve).toContain('outboxSide.close()');
  });
});

// ---------------------------------------------------------------------------
// The roots that wire NO outbox, and why none is needed.
//
// A turn reaches a channel through exactly two seams. `send_message` sends
// only once a host calls `setMessagingSend`; until then it answers with the
// default `gatewaySendRef` error in `packages/wiring/src/compose-tools.ts`
// ("Gateway not active — send_message requires gateway mode"). A watcher's
// `deliver` needs the watcher tools, which are registered only for a host that
// constructs a `WatcherManager`. A root with neither cannot publish, gated
// personality or not, so wiring it an outbox would gate nothing.
//
// `chat`, `cron`, `mcp`, `batch`, `eval`, `acp` and `bench` are those roots.
// The scan below fails the day one of them grows a seam without the gate.
// ---------------------------------------------------------------------------

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (extname(entry) === '.ts') out.push(full);
  }
  return out;
}

function filesMatching(pattern: RegExp): string[] {
  return walkTs(CLI_ROOT)
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(CLI_ROOT, file).replace(/\\/g, '/'))
    .sort();
}

describe('a root with no path to a channel needs no gate', () => {
  it('only the two gateway roots install a send function', () => {
    expect(filesMatching(/\.setMessagingSend\b|messagingSetters/)).toEqual([
      'commands/boot.ts',
      'commands/gateway.ts',
    ]);
  });

  it('only the gateway roots and serve construct a WatcherManager', () => {
    expect(filesMatching(/new WatcherManager\(/)).toEqual([
      'commands/boot.ts',
      'commands/gateway.ts',
      'commands/serve.ts',
    ]);
  });

  it('every root holding either seam constructs the outbox', () => {
    expect(gateway).toContain('createOutboxRuntime({');
    expect(boot).toContain('createOutboxRuntime({');
    expect(serve).toContain('createOutboxProposalSide({');
  });

  it.each(['chat.ts', 'cron.ts', 'mcp.ts', 'batch.ts', 'eval.ts', 'acp.ts', 'bench.ts'])(
    '%s holds neither seam, so it wires no outbox',
    (name) => {
      const source = read(name);
      expect(source).not.toMatch(/setMessagingSend|messagingSetters|watcherManager|WatcherManager/);
      expect(source).not.toContain('createOutbox');
    },
  );
});
