import { beforeEach, describe, expect, it, vi } from 'vitest';

const items = new Map<string, string>();
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
  getItemAsync: vi.fn(async (k: string) => items.get(k) ?? null),
  setItemAsync: vi.fn(async (k: string, v: string) => {
    items.set(k, v);
  }),
  deleteItemAsync: vi.fn(async (k: string) => {
    items.delete(k);
  }),
}));

import { useConnection } from '../../state/connection';
import { errorRow, isUnauthorized, SCOPE_HINT } from '../errors';

beforeEach(() => {
  items.clear();
});

describe('errorRow', () => {
  it('FORBIDDEN names the missing scope and the fix (case 3)', () => {
    const err = Object.assign(new Error('API key is missing required scope "kanban:read"'), {
      code: 'FORBIDDEN',
    });
    expect(errorRow(err, 'kanban.getBoard')).toEqual({
      glyph: '✗',
      word: 'scope',
      subject: 'kanban.getBoard',
      result:
        'API key is missing required scope "kanban:read" · Create a key with this scope on the web',
    });
    expect(errorRow(err, 'x').result).toContain(SCOPE_HINT);
  });

  it("a FORBIDDEN without a scope keeps the server's message", () => {
    const err = Object.assign(new Error('experimental'), { code: 'FORBIDDEN' });
    expect(errorRow(err, 's')).toEqual({
      glyph: '✗',
      word: 'failed',
      subject: 's',
      result: 'experimental',
    });
  });

  it('UNAUTHORIZED is the revoked-key row', () => {
    const err = Object.assign(new Error('gone'), { code: 'UNAUTHORIZED' });
    expect(errorRow(err, 'anything')).toEqual({
      glyph: '✗',
      word: 'key',
      subject: 'invalid or revoked',
      result: 'reconnect',
    });
    expect(isUnauthorized(err)).toBe(true);
    expect(isUnauthorized(new Error('x'))).toBe(false);
    expect(isUnauthorized('x')).toBe(false);
    expect(isUnauthorized(null)).toBe(false);
  });

  it('a plain error is a failed row', () => {
    expect(errorRow(new Error('boom'), 'sessions.list')).toEqual({
      glyph: '✗',
      word: 'failed',
      subject: 'sessions.list',
      result: 'boom',
    });
    expect(errorRow('text', 's').result).toBe('text');
  });
});

describe('connection', () => {
  it('UNAUTHORIZED mid-session forgets the key and keeps the URL (case 4)', async () => {
    await useConnection.getState().connect('http://10.0.0.2:3000', 'sk-ethos-abc');
    expect(items.get('ethos.api-key')).toBe('sk-ethos-abc');
    expect(useConnection.getState().client).not.toBeNull();

    await useConnection.getState().disconnect();
    expect(items.has('ethos.api-key')).toBe(false);
    expect(items.get('ethos.server-url')).toBe('http://10.0.0.2:3000');
    expect(useConnection.getState().key).toBeNull();
    expect(useConnection.getState().client).toBeNull();
    expect(useConnection.getState().url).toBe('http://10.0.0.2:3000');
  });
});
