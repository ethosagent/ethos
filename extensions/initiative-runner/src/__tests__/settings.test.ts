import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { effectiveEnabled, loadInitiativeSettings } from '../index';

const HOME = '/home/u/.ethos';
const DIR = `${HOME}/personalities/pm/initiatives`;
const FILE = `${DIR}/settings.yaml`;

describe('loadInitiativeSettings', () => {
  it('missing file = on, selfStart off, $0', async () => {
    const r = await loadInitiativeSettings(new InMemoryStorage(), HOME, 'pm');
    expect(r.status).toBe('missing');
    expect(r.settings).toMatchObject({ enabled: true, selfStart: false, dailyBudgetUsd: 0 });
    expect(effectiveEnabled(r.settings, {})).toBe(true);
  });

  it('reads a valid file', async () => {
    const s = new InMemoryStorage();
    await s.mkdir(DIR);
    await s.writeAtomic(FILE, 'selfStart: true\ndailyBudgetUsd: 2\n');
    const r = await loadInitiativeSettings(s, HOME, 'pm');
    expect(r.status).toBe('loaded');
    expect(r.settings).toMatchObject({ enabled: true, selfStart: true, dailyBudgetUsd: 2 });
  });

  it('operator enabled:false wins over personality on', async () => {
    const r = await loadInitiativeSettings(new InMemoryStorage(), HOME, 'pm');
    expect(r.settings.enabled).toBe(true);
    expect(effectiveEnabled(r.settings, { initiatives: { enabled: false } })).toBe(false);
    expect(effectiveEnabled(r.settings, { initiatives: { enabled: true } })).toBe(true);
  });

  it('invalid settings file pauses the engine for that personality with a reason', async () => {
    const s = new InMemoryStorage();
    await s.mkdir(DIR);
    await s.writeAtomic(FILE, 'allowWrites: true\n');
    const r = await loadInitiativeSettings(s, HOME, 'pm');
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain('allowWrites');
    expect(effectiveEnabled(r.settings, {})).toBe(false);
  });

  it('unparseable yaml is also paused with a reason', async () => {
    const s = new InMemoryStorage();
    await s.mkdir(DIR);
    await s.writeAtomic(FILE, 'a: [unclosed\n');
    const r = await loadInitiativeSettings(s, HOME, 'pm');
    expect(r.status).toBe('invalid');
    expect(r.reason).toBeTruthy();
    expect(r.settings.enabled).toBe(false);
  });

  it('unreadable settings file (read throws) is paused with the error as reason', async () => {
    class Unreadable extends InMemoryStorage {
      override async read(): Promise<string | null> {
        throw new Error('EACCES: permission denied');
      }
    }
    const r = await loadInitiativeSettings(new Unreadable(), HOME, 'pm');
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain('EACCES');
    expect(r.reason).toContain(FILE);
    expect(effectiveEnabled(r.settings, {})).toBe(false);
  });
});
