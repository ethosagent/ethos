import { describe, expect, it } from 'vitest';
import { createCapturingAdapter } from '../webhook-adapter';

describe('createCapturingAdapter', () => {
  it('accumulates text across send() calls in order', async () => {
    const { adapter, getReply } = createCapturingAdapter();
    await adapter.send('chat', { text: 'hello ' });
    await adapter.send('chat', { text: 'world' });
    expect(getReply()).toBe('hello world');
  });

  it('send() returns { ok: true }', async () => {
    const { adapter } = createCapturingAdapter();
    const result = await adapter.send('chat', { text: 'x' });
    expect(result).toEqual({ ok: true });
  });

  it('getReply() is empty before any send', () => {
    const { getReply } = createCapturingAdapter();
    expect(getReply()).toBe('');
  });

  it('exposes all required PlatformAdapter members', async () => {
    const { adapter } = createCapturingAdapter();
    expect(typeof adapter.id).toBe('string');
    expect(typeof adapter.displayName).toBe('string');
    expect(typeof adapter.canSendTyping).toBe('boolean');
    expect(typeof adapter.canEditMessage).toBe('boolean');
    expect(typeof adapter.canReact).toBe('boolean');
    expect(typeof adapter.canSendFiles).toBe('boolean');
    expect(typeof adapter.maxMessageLength).toBe('number');
    expect(typeof adapter.start).toBe('function');
    expect(typeof adapter.stop).toBe('function');
    expect(typeof adapter.send).toBe('function');
    expect(typeof adapter.onMessage).toBe('function');
    expect(typeof adapter.health).toBe('function');
    expect(await adapter.health()).toEqual({ ok: true });
  });
});
