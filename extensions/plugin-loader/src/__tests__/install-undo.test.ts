// The one undo both plugin install surfaces call (`install-undo.ts`), and the
// grant restore it is built on (`restoreGrant`, grants.ts). The surfaces' own
// tests drive it end to end (apps/ethos/src/__tests__/plugin-install.test.ts,
// apps/web-api/src/__tests__/services/plugins.service.install.test.ts); these pin
// the rules each surface relies on without a surface in the way.
//
// npm is an injected runner that records its argv; no network, no real npm.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type PluginGrant, readGrants, recordGrant, restoreGrant, revokeGrant } from '../grants';
import {
  describeUndoneInstall,
  findPreviousCopy,
  type PreviousPluginCopy,
  type UndoPluginInstallInput,
  undoPluginInstall,
} from '../install-undo';
import { type PluginLockEntry, readLockfile, writeLockfile } from '../lockfile';

const PKG = 'plugin-a';
const PLUGINS_DIR = '/data/plugins';
const PERSONALITIES_DIR = '/data/personalities';
const PKG_DIR = join(PLUGINS_DIR, 'node_modules', PKG);

function grant(version: string, extra: Partial<PluginGrant> = {}): PluginGrant {
  return {
    id: PKG,
    package: PKG,
    version,
    source: `npm:${PKG}@${version}`,
    capabilities: { shell: false, network: null },
    scan: { tier: 'community', findings: [], hasRed: false, hasYellow: false },
    grantedAt: `2026-0${version[0]}-01T00:00:00.000Z`,
    consent: 'flag',
    ...extra,
  };
}

/** A tarball pin, or with `legacy` a package.json-digest pin (no `integrityOf`). */
function pin(version: string, legacy = false): PluginLockEntry {
  return {
    package: PKG,
    version,
    registry: 'https://registry.npmjs.org',
    // A well-formed SRI: `readLockfile` drops an entry whose integrity is not one.
    integrity: `sha512-${createHash('sha512').update(version).digest('base64')}`,
    ...(legacy ? {} : { integrityOf: 'tarball' as const }),
  };
}

async function putPackage(storage: InMemoryStorage, version: string): Promise<void> {
  await storage.mkdir(PKG_DIR);
  await storage.write(join(PKG_DIR, 'package.json'), JSON.stringify({ name: PKG, version }));
}

function recordingNpm(storage: InMemoryStorage, opts: { uninstallFails?: boolean } = {}) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<void> => {
    calls.push(args);
    if (args[0] !== 'uninstall') throw new Error(`unexpected npm ${args[0]}`);
    if (opts.uninstallFails) throw new Error('npm error EACCES');
    if (await storage.exists(PKG_DIR)) await storage.remove(PKG_DIR, { recursive: true });
  };
  return { calls, run };
}

describe('restoreGrant', () => {
  it('puts the earlier grant back exactly, revocation included', async () => {
    const storage = new InMemoryStorage();
    await recordGrant(storage, PLUGINS_DIR, grant('1.0.0'));
    await revokeGrant(storage, PLUGINS_DIR, PKG, '2026-02-02T00:00:00.000Z');
    const previous = (await readGrants(storage, PLUGINS_DIR))[PKG] ?? null;
    await recordGrant(storage, PLUGINS_DIR, grant('2.0.0'));

    expect(
      await restoreGrant(storage, PLUGINS_DIR, { id: PKG, recorded: grant('2.0.0'), previous }),
    ).toBe('restored');
    expect((await readGrants(storage, PLUGINS_DIR))[PKG]).toEqual(previous);
  });

  it('deletes the grant, rather than revoking it, when none was recorded before', async () => {
    const storage = new InMemoryStorage();
    await recordGrant(storage, PLUGINS_DIR, grant('1.0.0', { id: 'plugin-b' }));
    await recordGrant(storage, PLUGINS_DIR, grant('2.0.0'));

    expect(
      await restoreGrant(storage, PLUGINS_DIR, {
        id: PKG,
        recorded: grant('2.0.0'),
        previous: null,
      }),
    ).toBe('removed');
    const grants = await readGrants(storage, PLUGINS_DIR);
    expect(grants[PKG]).toBeUndefined();
    expect(Object.keys(grants)).toEqual(['plugin-b']);
  });

  it('leaves a grant something else changed during the attempt alone, so an undo never un-revokes', async () => {
    const storage = new InMemoryStorage();
    await recordGrant(storage, PLUGINS_DIR, grant('2.0.0'));
    await revokeGrant(storage, PLUGINS_DIR, PKG);
    const revoked = (await readGrants(storage, PLUGINS_DIR))[PKG];

    expect(
      await restoreGrant(storage, PLUGINS_DIR, {
        id: PKG,
        recorded: grant('2.0.0'),
        previous: null,
      }),
    ).toBe('changed-since');
    expect((await readGrants(storage, PLUGINS_DIR))[PKG]).toEqual(revoked);
  });

  it("reports 'unchanged' when the attempt's grant never landed", async () => {
    const storage = new InMemoryStorage();
    await recordGrant(storage, PLUGINS_DIR, grant('1.0.0'));

    expect(
      await restoreGrant(storage, PLUGINS_DIR, {
        id: PKG,
        recorded: grant('2.0.0'),
        previous: grant('1.0.0'),
      }),
    ).toBe('unchanged');
  });
});

describe('findPreviousCopy', () => {
  const find = (storage: InMemoryStorage, preferredPersonality?: string) =>
    findPreviousCopy({
      storage,
      pluginsDir: PLUGINS_DIR,
      personalitiesDir: PERSONALITIES_DIR,
      name: PKG,
      preferredPersonality,
    });

  it('returns null when nothing is installed', async () => {
    expect(await find(new InMemoryStorage())).toBeNull();
  });

  it('finds a tarball pin for the installed version, preferring the named personality, and ignores legacy pins', async () => {
    const storage = new InMemoryStorage();
    await putPackage(storage, '1.0.0');
    for (const id of ['alpha', 'writer', 'legacy'])
      await storage.mkdir(join(PERSONALITIES_DIR, id));
    await writeLockfile(storage, join(PERSONALITIES_DIR, 'alpha'), { a: pin('1.0.0') });
    await writeLockfile(storage, join(PERSONALITIES_DIR, 'writer'), { w: pin('1.0.0') });
    await writeLockfile(storage, join(PERSONALITIES_DIR, 'legacy'), {
      l: pin('1.0.0', true),
    });

    expect(await find(storage, 'writer')).toEqual({
      version: '1.0.0',
      pin: { personalityId: 'writer', pluginId: 'w', entry: pin('1.0.0') },
    });
    expect((await find(storage, 'legacy'))?.pin?.personalityId).toBe('alpha');
  });

  it('has no version and no pin when the installed package.json is unreadable', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(PKG_DIR);
    await storage.write(join(PKG_DIR, 'package.json'), '{ not json');
    expect(await find(storage)).toEqual({ version: null, pin: null });
  });
});

describe('undoPluginInstall', () => {
  function undoInput(
    storage: InMemoryStorage,
    npm: ReturnType<typeof recordingNpm>,
    extra: Partial<UndoPluginInstallInput> = {},
  ): UndoPluginInstallInput {
    return {
      storage,
      pluginsDir: PLUGINS_DIR,
      name: PKG,
      previous: null,
      runNpm: npm.run,
      ...extra,
    };
  }

  it('before npm install ran: runs no npm, and puts the grant back', async () => {
    const storage = new InMemoryStorage();
    const npm = recordingNpm(storage);
    await recordGrant(storage, PLUGINS_DIR, grant('2.0.0'));

    const outcome = await undoPluginInstall({
      ...undoInput(storage, npm, {
        grant: { id: PKG, recorded: grant('2.0.0'), previous: null },
      }),
      stage: 'before-npm-install',
    });

    expect(outcome).toEqual({
      package: { kind: 'not-installed' },
      grant: { kind: 'removed' },
      pin: { kind: 'not-written' },
    });
    expect(npm.calls).toEqual([]);
  });

  it('after a failed npm install that left the previous copy in place: uninstalls nothing', async () => {
    const storage = new InMemoryStorage();
    const npm = recordingNpm(storage);
    await putPackage(storage, '1.0.0');
    const previous: PreviousPluginCopy = { version: '1.0.0', pin: null };

    const outcome = await undoPluginInstall({
      ...undoInput(storage, npm, { previous }),
      stage: 'npm-install-failed',
    });

    expect(outcome.package).toEqual({ kind: 'previous-intact' });
    expect(npm.calls).toEqual([]);
    expect(await storage.exists(PKG_DIR)).toBe(true);
  });

  it('after a failed npm install that left a different version: uninstalls it', async () => {
    const storage = new InMemoryStorage();
    const npm = recordingNpm(storage);
    await putPackage(storage, '2.0.0');

    const outcome = await undoPluginInstall({
      ...undoInput(storage, npm),
      stage: 'npm-install-failed',
    });

    expect(outcome.package).toEqual({ kind: 'removed' });
    expect(npm.calls).toEqual([['uninstall', '--prefix', PLUGINS_DIR, PKG]]);
  });

  it('keeps the grant when the uninstall fails, so the package on disk is never without its consent record', async () => {
    const storage = new InMemoryStorage();
    const npm = recordingNpm(storage, { uninstallFails: true });
    await putPackage(storage, '2.0.0');
    await recordGrant(storage, PLUGINS_DIR, grant('2.0.0'));

    const outcome = await undoPluginInstall({
      ...undoInput(storage, npm, {
        grant: { id: PKG, recorded: grant('2.0.0'), previous: grant('1.0.0') },
      }),
      stage: 'after-npm-install',
    });

    expect(outcome.package).toEqual({
      kind: 'left-on-disk',
      failure: 'npm uninstall failed: npm error EACCES',
    });
    expect(outcome.grant).toEqual({ kind: 'kept' });
    expect((await readGrants(storage, PLUGINS_DIR))[PKG]).toEqual(grant('2.0.0'));
  });

  it('puts the plugins.lock entry back only while it is still the one the attempt wrote', async () => {
    const storage = new InMemoryStorage();
    const npm = recordingNpm(storage);
    const personalityDir = join(PERSONALITIES_DIR, 'writer');
    await storage.mkdir(personalityDir);
    await writeLockfile(storage, personalityDir, { [PKG]: pin('2.0.0'), other: pin('3.0.0') });
    const pinInput = {
      personalityId: 'writer',
      personalityDir,
      pluginId: PKG,
      written: pin('2.0.0'),
      previous: pin('1.0.0'),
    };

    const restored = await undoPluginInstall({
      ...undoInput(storage, npm, { pin: pinInput }),
      stage: 'before-npm-install',
    });
    expect(restored.pin).toEqual({ kind: 'restored' });
    expect(await readLockfile(storage, personalityDir)).toEqual({
      [PKG]: pin('1.0.0'),
      other: pin('3.0.0'),
    });

    await writeLockfile(storage, personalityDir, { [PKG]: pin('4.0.0') });
    const changed = await undoPluginInstall({
      ...undoInput(storage, npm, { pin: pinInput }),
      stage: 'before-npm-install',
    });
    expect(changed.pin).toEqual({ kind: 'changed-since' });
    expect(await readLockfile(storage, personalityDir)).toEqual({ [PKG]: pin('4.0.0') });
  });

  it('reports a grant it could not put back as failed, instead of throwing', async () => {
    const storage = new InMemoryStorage();
    const npm = recordingNpm(storage);
    await storage.mkdir(PLUGINS_DIR);
    await storage.write(join(PLUGINS_DIR, 'grants.json'), '{ torn');

    const outcome = await undoPluginInstall({
      ...undoInput(storage, npm, {
        grant: { id: PKG, recorded: grant('2.0.0'), previous: null },
      }),
      stage: 'before-npm-install',
    });

    expect(outcome.grant.kind).toBe('failed');
  });
});

describe('describeUndoneInstall', () => {
  const undo: UndoPluginInstallInput = {
    storage: new InMemoryStorage(),
    pluginsDir: PLUGINS_DIR,
    name: PKG,
    previous: null,
    runNpm: async () => {},
  };
  const uninstall = `npm uninstall --prefix ${PLUGINS_DIR} ${PKG}`;

  it('says nothing was granted or pinned when the attempt wrote neither', () => {
    expect(
      describeUndoneInstall({
        undo,
        outcome: {
          package: { kind: 'removed' },
          grant: { kind: 'not-written' },
          pin: { kind: 'not-written' },
        },
        found: 'Something failed.',
        action: 'Retry.',
        restartsWhen: 'this server restarts',
      }),
    ).toEqual({
      cause: `Something failed. The install was rolled back (${uninstall}): nothing was left installed, granted or pinned.`,
      action: 'Retry.',
    });
  });

  it('never claims a grant it could not put back was undone, and says where to check it', () => {
    const { cause, action } = describeUndoneInstall({
      undo: { ...undo, grant: { id: PKG, recorded: grant('2.0.0'), previous: null } },
      outcome: {
        package: { kind: 'removed' },
        grant: { kind: 'failed', failure: 'EACCES' },
        pin: { kind: 'not-written' },
      },
      found: 'Something failed.',
      action: 'Retry.',
      restartsWhen: 'ethos next starts',
    });

    expect(cause).toBe(
      `Something failed. The install was rolled back (${uninstall}): nothing from this attempt was left installed. Putting back the capability grant for ${PKG} in ${PLUGINS_DIR}/grants.json failed (EACCES), so it still records ${PKG}@2.0.0 from this attempt.`,
    );
    expect(cause).not.toContain('granted or pinned');
    expect(action).toBe('Retry. Check the recorded grant with: ethos plugin grants.');
  });
});
