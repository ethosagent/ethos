import { DISPOSE_STEP_TIMEOUT_MS } from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import {
  boundedShutdownStep,
  SHUTDOWN_STEP_TIMEOUT_MS,
  type ShutdownStepSink,
} from '../bounded-shutdown-step';

type Block = Parameters<ShutdownStepSink['recordSafetyBlock']>[0];

function recorder() {
  const blocks: Block[] = [];
  const warnings: string[] = [];
  return {
    blocks,
    warnings,
    reporting: {
      sink: () => ({ recordSafetyBlock: (o: Block) => void blocks.push(o) }),
      warn: (m: string) => void warnings.push(m),
    },
  };
}

const never = (): Promise<void> => new Promise<void>(() => {});

describe('boundedShutdownStep', () => {
  it('uses the per-step bound a runtime dispose step gets', () => {
    expect(SHUTDOWN_STEP_TIMEOUT_MS).toBe(DISPOSE_STEP_TIMEOUT_MS);
  });

  it('a step that finishes is not reported', async () => {
    const r = recorder();
    let ran = false;
    await boundedShutdownStep(
      'adapters stop',
      async () => {
        ran = true;
      },
      r.reporting,
    );
    expect(ran).toBe(true);
    expect(r.blocks).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('a hung step is left behind at the bound and recorded by name', async () => {
    const r = recorder();
    const t0 = Date.now();
    await boundedShutdownStep('outbox drain', never, r.reporting, 50);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(1_000);
    expect(r.blocks).toEqual([
      {
        code: 'shutdown.step_timeout',
        cause: 'did not finish within 50ms — left behind',
        details: { step: 'outbox drain', timeoutMs: 50 },
      },
    ]);
    expect(r.warnings).toEqual([
      '[shutdown] outbox drain: did not finish within 50ms — left behind',
    ]);
  });

  it('a step that throws (sync or async) is recorded, never rethrown', async () => {
    const r = recorder();
    await boundedShutdownStep(
      'mesh unregister',
      () => {
        throw new Error('lock held');
      },
      r.reporting,
    );
    await boundedShutdownStep(
      'call-capture ownership',
      async () => {
        throw new Error('pid file gone');
      },
      r.reporting,
    );
    expect(r.blocks.map((b) => [b.code, b.details])).toEqual([
      ['shutdown.step_failed', { step: 'mesh unregister', error: 'lock held' }],
      ['shutdown.step_failed', { step: 'call-capture ownership', error: 'pid file gone' }],
    ]);
  });

  it('an unusable observability sink does not cost the shutdown', async () => {
    await expect(
      boundedShutdownStep(
        'adapters stop',
        never,
        {
          sink: () => {
            throw new Error('observability.db closed');
          },
          warn: () => {},
        },
        10,
      ),
    ).resolves.toBeUndefined();
  });

  // The shape every host's shutdown has: bounded steps, then the closes that
  // must run in order — ledger, spool, lock release — then the exit.
  it('hung and failing steps do not skip the ordered closes that follow', async () => {
    const r = recorder();
    const order: string[] = [];
    const shutdown = async () => {
      await boundedShutdownStep('outbox drain', never, r.reporting, 20);
      await boundedShutdownStep('call-capture ownership', never, r.reporting, 20);
      await boundedShutdownStep(
        'adapters stop',
        () => Promise.allSettled([never(), Promise.reject(new Error('socket'))]),
        r.reporting,
        20,
      );
      order.push('delivery ledger', 'inbound spool', 'gateway lock');
    };
    const t0 = Date.now();
    await shutdown();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(order).toEqual(['delivery ledger', 'inbound spool', 'gateway lock']);
    expect(r.blocks.map((b) => b.details?.step)).toEqual([
      'outbox drain',
      'call-capture ownership',
      'adapters stop',
    ]);
  });
});
