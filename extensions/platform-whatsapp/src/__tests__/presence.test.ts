import { describe, expect, it, vi } from 'vitest';
import { WhatsAppAdapter } from '../index';

// H1 (ux-feedback-and-config-clarity) — a WhatsApp DM shows `composing`
// presence during a turn. The gateway calls `sendTyping` fire-and-forget, so
// a presence failure must never escape the adapter.

function makeAdapter(sendPresenceUpdate?: (presence: string, jid?: string) => Promise<void>) {
  const adapter = new WhatsAppAdapter({ sessionDir: '/tmp/test-wa-presence', allowedJids: ['1'] });
  const spy = vi.fn(sendPresenceUpdate ?? (async () => {}));
  (adapter as unknown as { sock: unknown }).sock = { sendPresenceUpdate: spy };
  return { adapter, spy };
}

describe('WhatsAppAdapter.sendTyping', () => {
  it('advertises the typing capability', () => {
    const { adapter } = makeAdapter();
    expect(adapter.canSendTyping).toBe(true);
    expect(adapter.capabilities.typing).toBe(true);
    expect(typeof adapter.sendTyping).toBe('function');
  });

  it("sends a 'composing' presence update to the chat", async () => {
    const { adapter, spy } = makeAdapter();
    await adapter.sendTyping('1@s.whatsapp.net');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('composing', '1@s.whatsapp.net');
  });

  it('a socket error does not throw out of the adapter', async () => {
    const { adapter } = makeAdapter(async () => {
      throw new Error('Connection Closed');
    });
    await expect(adapter.sendTyping('1@s.whatsapp.net')).resolves.toBeUndefined();
  });

  it('a disconnected socket is a no-op', async () => {
    const adapter = new WhatsAppAdapter({
      sessionDir: '/tmp/test-wa-presence',
      allowedJids: ['1'],
    });
    await expect(adapter.sendTyping('1@s.whatsapp.net')).resolves.toBeUndefined();
  });
});
