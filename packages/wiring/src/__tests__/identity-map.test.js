import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { IdentityMap } from '../identity-map';

describe('IdentityMap', () => {
  it('mints a userId on first resolve', async () => {
    const storage = new InMemoryStorage();
    const map = new IdentityMap({ storage, dataDir: '/ethos' });
    const userId = await map.resolve('slack', 'U_A');
    expect(userId).toHaveLength(12);
    expect(/^[a-f0-9]{12}$/.test(userId)).toBe(true);
  });
  it('returns the same userId on repeated resolve for the same pair', async () => {
    const storage = new InMemoryStorage();
    const map = new IdentityMap({ storage, dataDir: '/ethos' });
    const first = await map.resolve('slack', 'U_A');
    const second = await map.resolve('slack', 'U_A');
    expect(second).toBe(first);
  });
  it('returns distinct userIds for different platform/user pairs', async () => {
    const storage = new InMemoryStorage();
    const map = new IdentityMap({ storage, dataDir: '/ethos' });
    const slackUser = await map.resolve('slack', 'U_A');
    const telegramUser = await map.resolve('telegram', 'T_A');
    expect(slackUser).not.toBe(telegramUser);
  });
  it('listUsers returns all known users', async () => {
    const storage = new InMemoryStorage();
    const map = new IdentityMap({ storage, dataDir: '/ethos' });
    await map.resolve('slack', 'U_A', 'Alice');
    await map.resolve('telegram', 'T_B', 'Bob');
    const users = await map.listUsers();
    expect(users).toHaveLength(2);
    expect(users[0].platform).toBe('slack');
    expect(users[0].platformUserId).toBe('U_A');
    expect(users[0].displayLabel).toBe('Alice');
    expect(users[1].platform).toBe('telegram');
    expect(users[1].platformUserId).toBe('T_B');
    expect(users[1].displayLabel).toBe('Bob');
  });
  it('persists entries across IdentityMap instances', async () => {
    const storage = new InMemoryStorage();
    const map1 = new IdentityMap({ storage, dataDir: '/ethos' });
    const userId = await map1.resolve('slack', 'U_A');
    // New instance, same storage — should load from disk
    const map2 = new IdentityMap({ storage, dataDir: '/ethos' });
    const resolved = await map2.resolve('slack', 'U_A');
    expect(resolved).toBe(userId);
  });
  it('uses default displayLabel when none is provided', async () => {
    const storage = new InMemoryStorage();
    const map = new IdentityMap({ storage, dataDir: '/ethos' });
    await map.resolve('slack', 'U_A');
    const users = await map.listUsers();
    expect(users[0].displayLabel).toBe('slack:U_A');
  });
});
