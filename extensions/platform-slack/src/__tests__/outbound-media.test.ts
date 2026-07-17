import type { Attachment } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { SlackAdapter } from '../adapter';

// The real Bolt App is constructed but never started (no socket opens), and the
// client is swapped for a spy — mirrors the receipt-reactions test harness.
function makeAdapter() {
  const adapter = new SlackAdapter({
    botToken: 'xoxb-fake',
    appToken: 'xapp-fake',
    signingSecret: 'sig-fake',
    botKey: 'test-bot',
  });
  const uploads: Array<Record<string, unknown>> = [];
  const uploadV2 = vi.fn(async (args: Record<string, unknown>) => {
    uploads.push(args);
    return { files: [{ ts: '1700000000.0001' }] };
  });
  (adapter as unknown as { client: unknown }).client = {
    files: { uploadV2 },
    reactions: { add: vi.fn(), remove: vi.fn() },
  } as never;
  return { adapter, uploads, uploadV2 };
}

const imageAtt: Attachment = {
  type: 'image',
  ref: 'chart.png',
  url: '/tmp/chart.png',
  mimeType: 'image/png',
  filename: 'chart.png',
};

describe('SlackAdapter outbound media (W3.2)', () => {
  it('advertises file-sending capability', () => {
    const { adapter } = makeAdapter();
    expect(adapter.canSendFiles).toBe(true);
    expect(adapter.capabilities.outboundFiles).toBe(true);
  });

  it('uploads a file via files.uploadV2 with the text as initial_comment', async () => {
    const { adapter, uploadV2, uploads } = makeAdapter();
    const res = await adapter.send('C123', { text: 'here you go', attachments: [imageAtt] });
    expect(res.ok).toBe(true);
    expect(uploadV2).toHaveBeenCalledTimes(1);
    expect(uploads[0]).toMatchObject({
      channel_id: 'C123',
      filename: 'chart.png',
      initial_comment: 'here you go',
    });
    // Path source passes through as-is (uploadV2 accepts a path string).
    expect(uploads[0]?.file).toBe('/tmp/chart.png');
  });

  it('decodes a data: URI to a Buffer', async () => {
    const { adapter, uploads } = makeAdapter();
    const b64 = Buffer.from('FILEBYTES').toString('base64');
    await adapter.send('C123', {
      text: '',
      attachments: [{ ...imageAtt, url: `data:image/png;base64,${b64}` }],
    });
    expect(Buffer.isBuffer(uploads[0]?.file)).toBe(true);
    expect((uploads[0]?.file as Buffer).toString()).toBe('FILEBYTES');
  });

  it('returns {ok:false,error} and does not double-send when uploadV2 rejects', async () => {
    const { adapter } = makeAdapter();
    const uploadV2 = vi.fn(async () => {
      throw new Error('file_upload_failed');
    });
    const postMessage = vi.fn().mockResolvedValue({ ts: '1' });
    (adapter as unknown as { client: unknown }).client = {
      files: { uploadV2 },
      chat: { postMessage },
      reactions: { add: vi.fn(), remove: vi.fn() },
    } as never;

    const res = await adapter.send('C123', { text: 'here you go', attachments: [imageAtt] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('file_upload_failed');
    // No fallback text post — a failed upload must not double-send.
    expect(postMessage).not.toHaveBeenCalled();
    expect(uploadV2).toHaveBeenCalledTimes(1);
  });

  it('gracefully returns ok with no messageId when uploadV2 yields no files', async () => {
    const { adapter } = makeAdapter();
    const uploadV2 = vi.fn(async () => ({ files: [] }));
    const postMessage = vi.fn().mockResolvedValue({ ts: '1' });
    (adapter as unknown as { client: unknown }).client = {
      files: { uploadV2 },
      chat: { postMessage },
      reactions: { add: vi.fn(), remove: vi.fn() },
    } as never;

    const res = await adapter.send('C123', { text: 'here you go', attachments: [imageAtt] });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBeUndefined();
    // No post-upload confirm send.
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('text-only sends do not touch the upload path', async () => {
    const { adapter, uploadV2 } = makeAdapter();
    // No attachments → falls through to chat.postMessage. Stub it to avoid network.
    (adapter as unknown as { client: { chat: unknown } }).client = {
      chat: { postMessage: vi.fn().mockResolvedValue({ ts: '1' }) },
      files: { uploadV2 },
      reactions: { add: vi.fn(), remove: vi.fn() },
    } as never;
    await adapter.send('C123', { text: 'plain' });
    expect(uploadV2).not.toHaveBeenCalled();
  });
});
