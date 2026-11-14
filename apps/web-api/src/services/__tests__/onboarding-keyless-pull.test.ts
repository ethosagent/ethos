import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasBirthMarker } from '@ethosagent/personalities';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { EthosError } from '@ethosagent/types';
import { contract, KeylessModelIdSchema } from '@ethosagent/web-contracts';
import { FunnelTracker } from '@ethosagent/wiring';
import { KEYLESS_MODEL_IDS } from '@ethosagent/wiring/keyless-probe';
import { describe, expect, it, vi } from 'vitest';
import type { OnboardingService } from '../onboarding.service';
import {
  DATA_DIR,
  makeFetch,
  makeRegistry,
  ollamaUp,
  useKeylessHarness,
} from './onboarding-keyless-harness';

describe('onboarding keyless RPCs', () => {
  const { make, done, expectOrpc } = useKeylessHarness();

  // -------------------------------------------------------------------------
  describe('pullModel / pullStatus', () => {
    it('starts a pull, reports byte progress, and ends in done', async () => {
      const { impl } = makeFetch({ '127.0.0.1:11434': ollamaUp([]) });
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const pullFn = vi.fn(async (o: { onProgress?: (p: unknown) => void; model: string }) => {
        o.onProgress?.({ status: 'pulling a', digest: 'a', total: 100, completed: 40 });
        o.onProgress?.({ status: 'pulling b', digest: 'b', total: 50, completed: 10 });
        await gate;
      }) as unknown as NonNullable<ConstructorParameters<typeof OnboardingService>[0]['pullFn']>;
      const { service } = make({ fetchFn: impl, pullFn });

      expect(service.pullStatus().state).toBe('idle');
      expect(await service.pullModel({ model: 'qwen3' })).toEqual({ ok: true });
      expect(pullFn).toHaveBeenCalledWith(expect.objectContaining({ model: 'qwen3' }));
      expect(service.pullStatus()).toEqual({
        state: 'pulling',
        completedBytes: 50,
        totalBytes: 150,
        error: null,
      });

      release();
      await vi.waitFor(() => expect(service.pullStatus().state).toBe('done'));
      expect(service.pullStatus()).toMatchObject({
        completedBytes: 50,
        totalBytes: 150,
        error: null,
      });
    });

    it('a second pull while one runs → 409 PULL_IN_PROGRESS', async () => {
      const { impl } = makeFetch({ '127.0.0.1:11434': ollamaUp([]) });
      const pullFn = vi.fn(() => new Promise<void>(() => {})) as unknown as NonNullable<
        ConstructorParameters<typeof OnboardingService>[0]['pullFn']
      >;
      const { service } = make({ fetchFn: impl, pullFn });
      await service.pullModel({ model: 'llama3.2' });
      await expectOrpc(service.pullModel({ model: 'qwen3' }), 'PULL_IN_PROGRESS', 409);
    });

    it('no Ollama on 127.0.0.1:11434 → 503 LOCAL_RUNTIME_UNREACHABLE, no pull started', async () => {
      const { impl } = makeFetch({});
      const pullFn = vi.fn() as unknown as NonNullable<
        ConstructorParameters<typeof OnboardingService>[0]['pullFn']
      >;
      const { service } = make({ fetchFn: impl, pullFn });
      await expectOrpc(service.pullModel({ model: 'qwen3' }), 'LOCAL_RUNTIME_UNREACHABLE', 503);
      expect(pullFn).not.toHaveBeenCalled();
      expect(service.pullStatus().state).toBe('idle');
    });

    it('a failed pull ends in error with Ollama status text only', async () => {
      const { impl } = makeFetch({ '127.0.0.1:11434': ollamaUp([]) });
      const { OllamaPullError } = await import('@ethosagent/wiring/ollama');
      const pullFn = vi.fn(async () => {
        throw new OllamaPullError('pull model manifest: file does not exist');
      }) as unknown as NonNullable<ConstructorParameters<typeof OnboardingService>[0]['pullFn']>;
      const { service } = make({ fetchFn: impl, pullFn });
      await service.pullModel({ model: 'qwen3' });
      await vi.waitFor(() => expect(service.pullStatus().state).toBe('error'));
      expect(service.pullStatus().error).toBe('pull model manifest: file does not exist');
      // A new pull may start after an error.
      await expect(service.pullModel({ model: 'qwen3' })).resolves.toEqual({ ok: true });
    });

    it('a model outside the enum is a 400 at the contract', () => {
      const schema = contract.onboarding.pullModel['~orpc'].inputSchema;
      expect(schema?.['~standard'].validate({ model: 'llama2:70b' })).toMatchObject({
        issues: expect.any(Array),
      });
    });

    it('pullModel enum equals KEYLESS_MODEL_IDS (drift guard for the web-contracts copy)', () => {
      expect([...KeylessModelIdSchema.options]).toEqual([...KEYLESS_MODEL_IDS]);
    });
  });

  // -------------------------------------------------------------------------
  describe('namePersonality', () => {
    it('duplicates, marks the copy born, and reloads the registry', async () => {
      const { registry, duplicate } = makeRegistry(['researcher']);
      const { service, storage } = make({ registry });

      const out = await service.namePersonality({ sourceId: 'researcher', name: 'Sage' });

      expect(out).toEqual({ personalityId: 'sage' });
      expect(duplicate).toHaveBeenCalledWith('researcher', 'sage');
      expect(await hasBirthMarker(storage, DATA_DIR, 'sage')).toBe(true);
      expect(registry.loadFromDirectory).toHaveBeenCalledWith(join(DATA_DIR, 'personalities'));
    });

    it('slugs spaces to dashes', async () => {
      const { service } = make({});
      expect(
        await service.namePersonality({ sourceId: 'researcher', name: '  My Research Bot ' }),
      ).toEqual({ personalityId: 'my-research-bot' });
    });

    it('unknown source → 404 PERSONALITY_NOT_FOUND', async () => {
      const { service } = make({});
      await expectOrpc(
        service.namePersonality({ sourceId: 'nope', name: 'Sage' }),
        'PERSONALITY_NOT_FOUND',
        404,
      );
    });

    it('taken id → 409 PERSONALITY_EXISTS and no second duplicate', async () => {
      const { registry, duplicate } = makeRegistry(['researcher', 'sage']);
      const { service } = make({ registry });
      await expectOrpc(
        service.namePersonality({ sourceId: 'researcher', name: 'Sage' }),
        'PERSONALITY_EXISTS',
        409,
      );
      expect(duplicate).not.toHaveBeenCalled();
    });

    it.each(['../etc', '.hidden', 'a/b', 'a\\b'])('unsafe name %j → 400', async (name) => {
      const { registry, duplicate } = makeRegistry(['researcher']);
      const { service } = make({ registry });
      await expectOrpc(
        service.namePersonality({ sourceId: 'researcher', name }),
        'BAD_REQUEST',
        400,
      );
      expect(duplicate).not.toHaveBeenCalled();
    });

    it('a registry INVALID_INPUT also surfaces as 400', async () => {
      const { registry } = makeRegistry(['researcher']);
      vi.mocked(registry.duplicate).mockRejectedValueOnce(
        new EthosError({ code: 'INVALID_INPUT', cause: 'bad id', action: 'pick another' }),
      );
      const { service } = make({ registry });
      await expectOrpc(
        service.namePersonality({ sourceId: 'researcher', name: 'Sage' }),
        'BAD_REQUEST',
        400,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('funnel', () => {
    function realTracker(storage: InMemoryStorage) {
      let t = 1_000;
      const observability = {
        recordFunnelSetupCompleted: vi.fn(),
        recordFunnelFirstReply: vi.fn(),
        recordFunnelChannelFirstReply: vi.fn(),
      };
      const tracker = new FunnelTracker({
        storage,
        dataDir: DATA_DIR,
        observability: observability as never,
        now: () => (t += 1_000),
      });
      return tracker;
    }

    it('state() on a missing config stamps firstLaunchAt once', async () => {
      const storage = new InMemoryStorage();
      const tracker = realTracker(storage);
      const { service } = make({ funnel: tracker, storage });

      expect((await service.state()).step).toBe('welcome');
      const first = (await tracker.readState())?.firstLaunchAt;
      expect(first).toBeTypeOf('number');
      await service.state();
      await service.probe().catch(() => {});
      expect((await tracker.readState())?.firstLaunchAt).toBe(first);
    });

    it('state() with a config present does not stamp', async () => {
      const storage = new InMemoryStorage();
      const tracker = realTracker(storage);
      const { service } = make({ funnel: tracker, storage, config: done });
      await service.state();
      expect(await tracker.readState()).toBeNull();
    });

    it('complete() forwards keylessPath to the funnel', async () => {
      const storage = new InMemoryStorage();
      const tracker = realTracker(storage);
      const { service } = make({ funnel: tracker, storage, config: null });
      await service.complete({
        provider: 'ollama',
        model: 'llama3.2',
        baseUrl: 'http://127.0.0.1:11434/v1',
        personalityId: 'researcher',
        keylessPath: 'local',
      });
      const state = await tracker.readState();
      expect(state?.keylessPath).toBe('local');
      expect(state?.setupProvider).toBe('ollama');
    });

    it('a funnel failure never fails the RPC', async () => {
      const funnel = {
        recordFirstLaunch: vi.fn(async () => {
          throw new Error('disk full');
        }),
        recordSetupCompleted: vi.fn(async () => {
          throw new Error('disk full');
        }),
      };
      const { service } = make({ funnel });
      await expect(service.state()).resolves.toMatchObject({ step: 'welcome' });
      await expect(
        service.complete({ provider: 'ollama', model: 'm', personalityId: 'researcher' }),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('D11: web-api never installs', () => {
    it('the onboarding service has no child_process / spawn path', async () => {
      const src = await readFile(join(import.meta.dirname, '..', 'onboarding.service.ts'), 'utf8');
      expect(src).not.toMatch(/child_process/);
      expect(src).not.toMatch(/\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/);
    });
  });
});
