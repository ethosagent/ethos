import { OutboxService, SQLiteOutboxStore } from '@ethosagent/outbox';
import type { EthosErrorCode } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runOutboxCommand } from '../outbox';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 16 (context-budget-2): `ethos outbox <sub> --json` prints exactly one JSON document.

let h: JsonCliHarness;
let service: OutboxService;
const io = {
  out: (l: string) => {
    throw new Error(`io.out leaked under --json: ${l}`);
  },
  err: (l: string) => {
    throw new Error(`io.err leaked under --json: ${l}`);
  },
  write: (r: string) => {
    throw new Error(`io.write leaked under --json: ${r}`);
  },
};

beforeEach(async () => {
  h = await setupJsonCli('ethos-outbox-json-');
  service = new OutboxService({
    store: new SQLiteOutboxStore(':memory:'),
    observability: { recordSafetyApproval: () => undefined },
  });
});

afterEach(async () => {
  service.close();
  await h.teardown();
});

function propose() {
  return service.propose({
    personalityId: 'writer',
    botKey: 'example-bot',
    platform: 'telegram',
    chatId: '-100200300',
    text: 'Launch notes',
  }).item;
}

describe('outbox --json', () => {
  it('--json success is one JSON doc', () => {
    const item = propose();
    expect(runOutboxCommand(['list', '--all', '--json'], service, io)).toBe(0);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(true);
    expect(doc.count).toBe(1);
    expect(doc.items).toMatchObject([{ id: item.id, personalityId: 'writer' }]);
  });

  it('--json show carries the item and the exact revision text', () => {
    const item = propose();
    expect(runOutboxCommand(['show', item.id, '--json'], service, io)).toBe(0);
    const doc = parseOneDoc(h);
    expect(doc.item).toMatchObject({ id: item.id });
    expect(doc.revision).toMatchObject({ text: 'Launch notes' });
  });

  it('--json list with no outbox is an empty doc', () => {
    expect(runOutboxCommand(['list', '--json'], null, io)).toBe(0);
    expect(parseOneDoc(h)).toEqual({ ok: true, count: 0, items: [] });
  });

  it('--json usage error is one JSON doc', () => {
    expect(() => runOutboxCommand(['approve', 'x', '--json'], service, io)).toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    const code: EthosErrorCode = 'INVALID_INPUT';
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe(code);
  });

  it('--json unknown item is one NOT_FOUND doc', () => {
    expect(() => runOutboxCommand(['show', 'ghost', '--json'], service, io)).toThrow(`${EXIT}(1)`);
    const code: EthosErrorCode = 'NOT_FOUND';
    expect(parseOneDoc(h).error?.code).toBe(code);
  });
});
