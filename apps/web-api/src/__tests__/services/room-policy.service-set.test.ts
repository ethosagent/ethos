// plan channel-prompts-ui L4 — RoomPolicyService; shared setup in room-policy.service.fixtures.ts.

import { parseConfigYaml } from '@ethosagent/config';
import { describe, expect, it } from 'vitest';
import {
  CONFIG,
  channelLines,
  failure,
  fileOf,
  installRoomPolicyHarness,
  repo,
  seed,
  storage,
  svc,
} from './room-policy.service.fixtures';

installRoomPolicyHarness();

describe('setRoomPolicy', () => {
  const entry = {
    prompt: 'This channel coordinates production deploys.\nConfirm service and environment first.',
    skills: ['deploy-runbook'],
    tier: 'trivial' as const,
    mode: 'mention_only',
    silent: false,
  };

  it('creates: prompt to a file, short fields to typed lines, file written first', async () => {
    const order: string[] = [];
    const writeAtomic = storage.writeAtomic.bind(storage);
    storage.writeAtomic = async (p, c, o) => {
      order.push(p);
      return writeAtomic(p, c, o);
    };
    const res = await svc.setRoomPolicy({
      platform: 'slack',
      selector: 'C0DEPLOY',
      entry,
      expectedVersion: null,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(order[0]).toBe(fileOf('slack', 'C0DEPLOY'));
    expect(order[1]).toBe(CONFIG);
    expect(await storage.read(fileOf('slack', 'C0DEPLOY'))).toBe(entry.prompt);
    expect(await channelLines()).toEqual([
      'channels.slack.C0DEPLOY.skills: deploy-runbook',
      'channels.slack.C0DEPLOY.tier: trivial',
      'channels.slack.C0DEPLOY.silent: false',
      'channels.slack.C0DEPLOY.mode: mention_only',
    ]);
    expect(res.entry).toMatchObject({
      selector: 'C0DEPLOY',
      kind: 'room',
      source: 'both',
      fields: { skills: ['deploy-runbook'], tier: 'trivial', mode: 'mention_only', silent: false },
      prompt: { source: 'file', path: fileOf('slack', 'C0DEPLOY'), chars: entry.prompt.length },
    });
    // The same text through the real parser: what the gateway will build.
    const parsed = parseConfigYaml((await storage.read(CONFIG)) ?? '');
    expect(parsed.channels?.slack?.entries.C0DEPLOY).toEqual({
      skills: ['deploy-runbook'],
      tier: 'trivial',
      silent: false,
      mode: 'mention_only',
    });
  });

  it('updates in place, removes an inline prompt, and leaves other lines byte-identical', async () => {
    await seed([
      'channels.slack.*.prompt: everyone',
      'channels.slack.C0X.prompt: inline wins today',
      'channels.slack.C0X.model: old',
      'channels.slack.name:deploys.prompt: keep me',
      'channels.telegram.-100.mode: all',
    ]);
    const before = (await svc.listRoomPolicies({ platform: 'slack' })).entries.find(
      (e) => e.selector === 'C0X',
    );
    const res = await svc.setRoomPolicy({
      platform: 'slack',
      selector: 'C0X',
      entry: { prompt: 'file now', tier: 'deep' },
      expectedVersion: before?.version ?? null,
    });
    expect(res.ok).toBe(true);
    expect(await channelLines()).toEqual([
      'channels.slack.*.prompt: everyone',
      'channels.slack.C0X.tier: deep',
      'channels.slack.name:deploys.prompt: keep me',
      'channels.telegram.-100.mode: all',
    ]);
    expect(await storage.read(fileOf('slack', 'C0X'))).toBe('file now');
  });

  it('a blank prompt removes an existing file', async () => {
    await seed([], { [fileOf('slack', 'C0X')]: 'old' });
    const cur = (await svc.listRoomPolicies({ platform: 'slack' })).entries[0];
    const res = await svc.setRoomPolicy({
      platform: 'slack',
      selector: 'C0X',
      entry: { prompt: '  \n', silent: true },
      expectedVersion: cur?.version ?? null,
    });
    expect(res.ok).toBe(true);
    expect(await storage.exists(fileOf('slack', 'C0X'))).toBe(false);
  });

  it('writes wildcard and DM files under their reserved names', async () => {
    await svc.setRoomPolicy({
      platform: 'slack',
      selector: '*',
      entry: { prompt: 'a' },
      expectedVersion: null,
    });
    await svc.setRoomPolicy({
      platform: 'slack',
      selector: '*dm',
      entry: { prompt: 'b' },
      expectedVersion: null,
    });
    expect(await storage.read(fileOf('slack', '_rooms'))).toBe('a');
    expect(await storage.read(fileOf('slack', '_dms'))).toBe('b');
  });

  describe('expectedVersion (409)', () => {
    it('null means the selector must not exist', async () => {
      await seed(['channels.slack.C0X.silent: true']);
      const err = await failure(
        svc.setRoomPolicy({
          platform: 'slack',
          selector: 'C0X',
          entry: { silent: false },
          expectedVersion: null,
        }),
      );
      expect(err.code).toBe('CONFIG_CONFLICT');
      expect(await channelLines()).toEqual(['channels.slack.C0X.silent: true']);
    });

    it('a stale version is refused and nothing is written', async () => {
      await seed(['channels.slack.C0X.silent: true']);
      const err = await failure(
        svc.setRoomPolicy({
          platform: 'slack',
          selector: 'C0X',
          entry: { prompt: 'p' },
          expectedVersion: 'deadbeef',
        }),
      );
      expect(err.code).toBe('CONFIG_CONFLICT');
      expect(await storage.exists(fileOf('slack', 'C0X'))).toBe(false);
    });

    it('a version for an entry that no longer exists conflicts', async () => {
      const err = await failure(
        svc.setRoomPolicy({
          platform: 'slack',
          selector: 'C0X',
          entry: { silent: true },
          expectedVersion: 'abcd1234',
        }),
      );
      expect(err.code).toBe('CONFIG_CONFLICT');
    });

    it('a second tab holding the old version loses', async () => {
      const first = await svc.setRoomPolicy({
        platform: 'slack',
        selector: 'C0X',
        entry: { prompt: 'one' },
        expectedVersion: null,
      });
      if (!first.ok) throw new Error('setup');
      const ok = await svc.setRoomPolicy({
        platform: 'slack',
        selector: 'C0X',
        entry: { prompt: 'two' },
        expectedVersion: first.entry.version,
      });
      expect(ok.ok).toBe(true);
      const err = await failure(
        svc.setRoomPolicy({
          platform: 'slack',
          selector: 'C0X',
          entry: { prompt: 'three' },
          expectedVersion: first.entry.version,
        }),
      );
      expect(err.code).toBe('CONFIG_CONFLICT');
      expect(await storage.read(fileOf('slack', 'C0X'))).toBe('two');
    });
  });

  describe('config write fails after the file write', () => {
    it('reports fileRemoved (not fileWritten) when a blank prompt deleted the file', async () => {
      await seed([], { [fileOf('slack', 'C0X')]: 'old file' });
      const cur = (await svc.listRoomPolicies({ platform: 'slack' })).entries[0];
      repo.transform = (async () => {
        throw new Error('EACCES');
      }) as typeof repo.transform;
      const partial = await svc.setRoomPolicy({
        platform: 'slack',
        selector: 'C0X',
        entry: { prompt: '', tier: 'deep' },
        expectedVersion: cur?.version ?? null,
      });
      expect(partial).toMatchObject({
        ok: false,
        reason: 'partial',
        fileWritten: false,
        fileRemoved: true,
        configWritten: false,
      });
    });

    it('returns a typed partial, then the identical retry converges', async () => {
      await seed(['channels.slack.C0X.prompt: old inline', 'channels.slack.C0X.tier: deep']);
      const cur = (await svc.listRoomPolicies({ platform: 'slack' })).entries[0];
      const real = repo.transform.bind(repo);
      let fail = true;
      repo.transform = (async (fn: Parameters<typeof real>[0]) => {
        if (fail) throw new Error('EACCES');
        return real(fn);
      }) as typeof repo.transform;
      const input = {
        platform: 'slack' as const,
        selector: 'C0X',
        entry: { prompt: 'new text', tier: 'trivial' as const },
        expectedVersion: cur?.version ?? null,
      };
      const partial = await svc.setRoomPolicy(input);
      expect(partial).toEqual({
        ok: false,
        reason: 'partial',
        fileWritten: true,
        fileRemoved: false,
        configWritten: false,
        cause: 'config.yaml write failed: EACCES',
      });
      // Until the config step lands the old inline prompt still wins: nothing lost.
      expect(await channelLines()).toContain('channels.slack.C0X.prompt: old inline');
      expect(await storage.read(fileOf('slack', 'C0X'))).toBe('new text');

      fail = false;
      const done = await svc.setRoomPolicy(input);
      expect(done.ok).toBe(true);
      expect(await channelLines()).toEqual(['channels.slack.C0X.tier: trivial']);
    });

    it('a different request after a partial is still a conflict', async () => {
      await seed(['channels.slack.C0X.tier: deep']);
      const cur = (await svc.listRoomPolicies({ platform: 'slack' })).entries[0];
      const real = repo.transform.bind(repo);
      repo.transform = (async () => {
        throw new Error('EACCES');
      }) as typeof repo.transform;
      await svc.setRoomPolicy({
        platform: 'slack',
        selector: 'C0X',
        entry: { prompt: 'a' },
        expectedVersion: cur?.version ?? null,
      });
      repo.transform = real;
      const err = await failure(
        svc.setRoomPolicy({
          platform: 'slack',
          selector: 'C0X',
          entry: { prompt: 'b' },
          expectedVersion: cur?.version ?? null,
        }),
      );
      expect(err.code).toBe('CONFIG_CONFLICT');
    });
  });
});
