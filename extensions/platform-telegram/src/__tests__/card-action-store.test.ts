import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { CARD_TOKEN_LENGTH } from '../cards/callback';
import { CARD_ACTION_TTL_MS, CardActionStore } from '../store/card-actions';

// plan telegram-live-cards L3 — the token map behind `rca:<token>:<i>` buttons. A restart must
// keep a settled card settled ("Already chosen"); a vanished file must read as expired, never as
// a silent turn.

const DIR = 'telegram/test-bot';
const FILE = `${DIR}/card-actions.jsonl`;
const T0 = 1_700_000_000_000;

const input = (over: Record<string, unknown> = {}) => ({
  chatId: '77',
  messageId: '500',
  question: 'Which sector?',
  actions: [
    { label: 'Tech', prompt: 'Break down tech' },
    { label: 'Energy', prompt: 'Break down energy' },
  ],
  ...over,
});

const storeAt = (storage: InMemoryStorage | undefined, now: number) =>
  new CardActionStore(storage, DIR, { now: () => now });

describe('CardActionStore', () => {
  it('mints distinct base32 tokens of the documented length', () => {
    const store = storeAt(new InMemoryStorage(), T0);
    const a = store.newToken();
    const b = store.newToken();
    expect(a).toMatch(/^[A-Z2-7]+$/);
    expect(a).toHaveLength(CARD_TOKEN_LENGTH);
    expect(a).not.toBe(b);
  });

  it('put then lookup returns the actions and message', async () => {
    const store = storeAt(new InMemoryStorage(), T0);
    await store.load();
    const token = store.newToken();
    await store.put(token, input());

    const found = store.lookup(token);
    expect(found.status).toBe('ok');
    if (found.status !== 'ok') return;
    expect(found.record.messageId).toBe('500');
    expect(found.record.actions[1]).toEqual({ label: 'Energy', prompt: 'Break down energy' });
  });

  it('an unknown token is expired', async () => {
    const store = storeAt(new InMemoryStorage(), T0);
    await store.load();
    expect(store.lookup('AAAAAAAAAA')).toEqual({ status: 'expired' });
  });

  it('settle is single-use: the second settle reports already, with the chosen index', async () => {
    const store = storeAt(new InMemoryStorage(), T0);
    await store.load();
    const token = store.newToken();
    await store.put(token, input());

    expect((await store.settle(token, 1)).status).toBe('settled');
    const second = await store.settle(token, 0);
    expect(second.status).toBe('already');
    expect(store.lookup(token)).toMatchObject({ status: 'settled', index: 1 });
  });

  it('two taps racing in one process settle exactly once', async () => {
    const store = storeAt(new InMemoryStorage(), T0);
    await store.load();
    const token = store.newToken();
    await store.put(token, input());

    const [a, b] = await Promise.all([store.settle(token, 0), store.settle(token, 1)]);

    expect([a.status, b.status].sort()).toEqual(['already', 'settled']);
  });

  it('an out-of-range index is invalid and does not settle the card', async () => {
    const store = storeAt(new InMemoryStorage(), T0);
    await store.load();
    const token = store.newToken();
    await store.put(token, input());

    expect((await store.settle(token, 9)).status).toBe('invalid');
    expect(store.lookup(token).status).toBe('ok');
  });

  it('survives a restart: a fresh load on the same Storage still knows the card and that it is settled', async () => {
    const storage = new InMemoryStorage();
    const first = storeAt(storage, T0);
    await first.load();
    const open = first.newToken();
    const chosen = first.newToken();
    await first.put(open, input());
    await first.put(chosen, input({ messageId: '501' }));
    await first.settle(chosen, 0);

    const second = storeAt(storage, T0 + 60_000);
    await second.load();

    expect(second.lookup(open).status).toBe('ok');
    expect(second.lookup(chosen)).toMatchObject({ status: 'settled', index: 0 });
    expect((await second.settle(chosen, 1)).status).toBe('already');
  });

  it('a deleted file reads as expired after restart, never as a live card', async () => {
    const storage = new InMemoryStorage();
    const first = storeAt(storage, T0);
    await first.load();
    const token = first.newToken();
    await first.put(token, input());
    await storage.remove(FILE);

    const second = storeAt(storage, T0 + 1000);
    await second.load();

    expect(second.lookup(token)).toEqual({ status: 'expired' });
  });

  it('a card older than the TTL is expired, in memory and after reload', async () => {
    const storage = new InMemoryStorage();
    let now = T0;
    const store = new CardActionStore(storage, DIR, { now: () => now });
    await store.load();
    const token = store.newToken();
    await store.put(token, input());

    now = T0 + CARD_ACTION_TTL_MS - 1;
    expect(store.lookup(token).status).toBe('ok');
    now = T0 + CARD_ACTION_TTL_MS + 1;
    expect(store.lookup(token)).toEqual({ status: 'expired' });
    expect((await store.settle(token, 0)).status).toBe('expired');

    const reloaded = storeAt(storage, now);
    await reloaded.load();
    expect(reloaded.lookup(token)).toEqual({ status: 'expired' });
  });

  it('skips a malformed or foreign line and keeps the rest', async () => {
    const storage = new InMemoryStorage();
    const first = storeAt(storage, T0);
    await first.load();
    const token = first.newToken();
    await first.put(token, input());
    await storage.append(FILE, 'not json\n{"type":"put","token":5}\n{"type":"unknown"}\n');

    const second = storeAt(storage, T0 + 1);
    await second.load();

    expect(second.lookup(token).status).toBe('ok');
  });

  it('compacts the file on load once more than half of it is expired', async () => {
    const storage = new InMemoryStorage();
    const first = storeAt(storage, T0);
    await first.load();
    const stale = [first.newToken(), first.newToken(), first.newToken()];
    for (const token of stale) await first.put(token, input());
    const laterStore = storeAt(storage, T0 + CARD_ACTION_TTL_MS - 1000);
    await laterStore.load();
    const live = laterStore.newToken();
    await laterStore.put(live, input({ messageId: '900' }));
    await laterStore.settle(live, 1);

    const reload = storeAt(storage, T0 + CARD_ACTION_TTL_MS + 1000);
    await reload.load();

    const raw = (await storage.read(FILE)) ?? '';
    for (const token of stale) expect(raw).not.toContain(token);
    expect(raw).toContain(live);
    expect(raw.trim().split('\n')).toHaveLength(2); // the live put + its settle
    expect(reload.lookup(live)).toMatchObject({ status: 'settled', index: 1 });
  });

  it('does not rewrite the file when most of it is still live', async () => {
    const storage = new InMemoryStorage();
    const first = storeAt(storage, T0);
    await first.load();
    const a = first.newToken();
    await first.put(a, input());
    await first.put(first.newToken(), input());
    const before = await storage.read(FILE);

    const second = storeAt(storage, T0 + 1000);
    await second.load();

    expect(await storage.read(FILE)).toBe(before);
  });

  it('memory-only mode (no Storage) works within the process and forgets on a new store', async () => {
    const first = storeAt(undefined, T0);
    await first.load();
    const token = first.newToken();
    await first.put(token, input());
    expect(first.lookup(token).status).toBe('ok');
    expect((await first.settle(token, 0)).status).toBe('settled');

    const second = storeAt(undefined, T0 + 1);
    await second.load();
    expect(second.lookup(token)).toEqual({ status: 'expired' });
  });
});
