// Enforces the snapshot guarantees of plan/phases/share-links.md §3, §4 and D5/D6/D8:
// role filter, tool-name-only toggle, secret and PII redaction, determinism.
import { MAX_SNAPSHOT_BYTES } from '@ethosagent/share-links';
import { COMPACTION_ROW_TOOL_NAME } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  buildShareSnapshot,
  type ShareSnapshotMessage,
  shareSnapshotBytes,
} from '../share-snapshot';

const GHP = `ghp_${'a'.repeat(36)}`;
const ANT = `sk-ant-${'b'.repeat(95)}`;
const PEM =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END RSA PRIVATE KEY-----';
const URL_CRED = 'postgres://admin:hunter2pass@db.internal:5432/app';

const session = { title: 'Debug', personalityId: 'researcher' };
const opts = { includeToolNames: false, createdAt: '2026-11-22T10:00:00.000Z' };

function msg(over: Partial<ShareSnapshotMessage> & { role: string }): ShareSnapshotMessage {
  return { content: '', ...over };
}

describe('buildShareSnapshot', () => {
  it('keeps only user, user_steer (as user) and assistant rows', () => {
    const snap = buildShareSnapshot(
      session,
      [
        msg({ role: 'system', content: 'SYSTEM PROMPT' }),
        msg({ role: 'user', content: 'hi' }),
        msg({ role: 'user_steer', content: 'actually, be brief' }),
        msg({ role: 'tool_result', content: 'TOOL OUTPUT', toolCallId: 'c1' }),
        msg({ role: 'mystery', content: 'WEIRD' }),
        msg({ role: 'assistant', content: 'hello' }),
      ],
      opts,
    );
    expect(snap).toEqual({
      v: 1,
      title: 'Debug',
      personalityId: 'researcher',
      createdAt: opts.createdAt,
      turns: [
        { role: 'user', text: 'hi' },
        { role: 'user', text: 'actually, be brief' },
        { role: 'assistant', text: 'hello' },
      ],
    });
    const json = JSON.stringify(snap);
    expect(json).not.toContain('SYSTEM PROMPT');
    expect(json).not.toContain('TOOL OUTPUT');
    expect(json).not.toContain('WEIRD');
  });

  it('never carries tool inputs or outputs, with or without tool names', () => {
    const rows = [
      msg({
        role: 'assistant',
        content: 'running',
        toolCalls: [{ id: 'c1', name: 'bash', input: { command: 'cat /etc/SECRET_INPUT' } }],
      }),
      msg({ role: 'tool_result', content: 'SECRET_OUTPUT', toolCallId: 'c1', isError: false }),
    ];
    for (const includeToolNames of [false, true]) {
      const json = JSON.stringify(buildShareSnapshot(session, rows, { ...opts, includeToolNames }));
      expect(json).not.toContain('SECRET_INPUT');
      expect(json).not.toContain('SECRET_OUTPUT');
    }
  });

  it('adds tools only on assistant turns and only when includeToolNames is true', () => {
    const rows = [
      msg({
        role: 'assistant',
        content: 'done',
        toolCalls: [
          { id: 'c1', name: 'read_file', input: {} },
          { id: 'c2', name: 'bash', input: {} },
          { id: 'c3', name: 'web_search', input: {} },
        ],
      }),
      msg({ role: 'tool_result', content: 'ok', toolCallId: 'c1', isError: false }),
      msg({ role: 'tool_result', content: 'boom', toolCallId: 'c2', isError: true }),
      msg({ role: 'user', content: 'thanks' }),
    ];
    const off = buildShareSnapshot(session, rows, opts);
    expect(off.turns[0]).toEqual({ role: 'assistant', text: 'done' });
    const on = buildShareSnapshot(session, rows, { ...opts, includeToolNames: true });
    expect(on.turns[0]?.tools).toEqual([
      { name: 'read_file', isError: false },
      { name: 'bash', isError: true },
      // no recorded tool_result flag: not claimed as an error
      { name: 'web_search', isError: false },
    ]);
    expect(on.turns[1]).toEqual({ role: 'user', text: 'thanks' });
  });

  it('redacts seeded secrets in text and title', () => {
    const snap = buildShareSnapshot(
      { title: `leak ${GHP}`, personalityId: 'researcher' },
      [
        msg({ role: 'user', content: `key ${ANT} and token ${GHP}` }),
        msg({ role: 'assistant', content: `${PEM}\nconnect to ${URL_CRED}` }),
      ],
      opts,
    );
    const json = JSON.stringify(snap);
    expect(json).not.toContain(GHP);
    expect(json).not.toContain(ANT);
    expect(json).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    expect(json).not.toContain('hunter2pass');
    expect(snap.title).toContain('[REDACTED:github-pat]');
    expect(snap.turns[0]?.text).toContain('[REDACTED:anthropic-key]');
    expect(snap.turns[0]?.text).toContain('[REDACTED:github-pat]');
    expect(snap.turns[1]?.text).toContain('[REDACTED:private-key]');
    expect(snap.turns[1]?.text).toContain('[REDACTED:url-credential]');
  });

  it('pii default on; kept when options.pii === false', () => {
    const rows = [
      msg({ role: 'user', content: 'mail me at jane.doe@example.com or +1 415 555 0132' }),
    ];
    const redacted = buildShareSnapshot(session, rows, opts);
    expect(redacted.turns[0]?.text).toContain('[REDACTED:email]');
    expect(redacted.turns[0]?.text).toContain('[REDACTED:phone]');
    expect(redacted.turns[0]?.text).not.toContain('jane.doe@example.com');
    const kept = buildShareSnapshot(session, rows, { ...opts, pii: false });
    expect(kept.turns[0]?.text).toContain('jane.doe@example.com');
    expect(kept.turns[0]?.text).toContain('415');
  });

  it('still redacts secrets when pii is false', () => {
    const snap = buildShareSnapshot(session, [msg({ role: 'user', content: GHP })], {
      ...opts,
      pii: false,
    });
    expect(snap.turns[0]?.text).toBe('[REDACTED:github-pat]');
  });

  it('drops empty-text assistant rows with no tools, and compaction rows', () => {
    const snap = buildShareSnapshot(
      session,
      [
        msg({ role: 'assistant', content: '   ' }),
        msg({ role: 'assistant', content: 'summary', toolName: COMPACTION_ROW_TOOL_NAME }),
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'bash', input: {} }],
        }),
        msg({ role: 'assistant', content: 'real' }),
      ],
      opts,
    );
    expect(snap.turns).toEqual([{ role: 'assistant', text: 'real' }]);
    const withTools = buildShareSnapshot(
      session,
      [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'bash', input: {} }],
        }),
      ],
      { ...opts, includeToolNames: true },
    );
    expect(withTools.turns).toEqual([
      { role: 'assistant', text: '', tools: [{ name: 'bash', isError: false }] },
    ]);
  });

  it('is deterministic and reads no clock', () => {
    const rows = [
      msg({ role: 'user', content: `x ${GHP}` }),
      msg({ role: 'assistant', content: 'y', toolCalls: [{ id: 'c', name: 'bash', input: {} }] }),
    ];
    const a = buildShareSnapshot(session, rows, { ...opts, includeToolNames: true });
    const b = buildShareSnapshot(session, rows, { ...opts, includeToolNames: true });
    expect(a).toEqual(b);
    expect(a.createdAt).toBe(opts.createdAt);
  });

  it('falls back for missing title and personality', () => {
    const snap = buildShareSnapshot({ title: null, personalityId: null }, [], opts);
    expect(snap.title).toBe('Untitled session');
    expect(snap.personalityId).toBeNull();
  });

  it('reports serialized size against the 2 MB cap', () => {
    expect(MAX_SNAPSHOT_BYTES).toBe(2 * 1024 * 1024);
    const small = buildShareSnapshot(session, [msg({ role: 'user', content: 'é' })], opts);
    expect(shareSnapshotBytes(small)).toBe(Buffer.byteLength(JSON.stringify(small), 'utf8'));
    const big = buildShareSnapshot(
      session,
      [msg({ role: 'user', content: 'a'.repeat(MAX_SNAPSHOT_BYTES) })],
      opts,
    );
    expect(shareSnapshotBytes(big)).toBeGreaterThan(MAX_SNAPSHOT_BYTES);
  });
  it('never copies attachment annotations, inline file text or error lines (D5)', () => {
    const stored = [
      '<attachments>\n- UPLOADED_NAME.pdf (application/pdf, 12 KB)\n</attachments>',
      '<voice-origin transport="browser-talk-mode" speaker="owner"/>\nThis turn was spoken.',
      'Failed to read "BAD_FILE.bin": file could not be decoded as text',
      '=== file: notes.txt [truncated to 5 chars from 99,999] ===\nUPLOADED_BODY\n=== end file ===',
      'summarise the typed question',
    ].join('\n\n');
    const snap = buildShareSnapshot(
      session,
      [
        msg({ role: 'user', content: stored }),
        msg({ role: 'user_steer', content: `${stored.split('\n\n').slice(3).join('\n\n')}` }),
      ],
      opts,
    );
    const json = JSON.stringify(snap);
    for (const leaked of ['UPLOADED', 'BAD_FILE', 'attachments', 'voice-origin', 'end file']) {
      expect(json).not.toContain(leaked);
    }
    expect(snap.turns.map((t) => t.text)).toEqual([
      'summarise the typed question',
      'summarise the typed question',
    ]);
  });

  it('drops a user row that was only attachments', () => {
    const snap = buildShareSnapshot(
      session,
      [msg({ role: 'user', content: '<attachments>\n- a.png (image/png)\n</attachments>' })],
      opts,
    );
    expect(snap.turns).toEqual([]);
  });

  it('strips the interrupted marker (provider error text) from assistant rows', () => {
    const snap = buildShareSnapshot(
      session,
      [
        msg({
          role: 'assistant',
          content: 'partial answer\n\n[interrupted — 502 <html>upstream</html>]',
        }),
      ],
      opts,
    );
    expect(snap.turns).toEqual([{ role: 'assistant', text: 'partial answer' }]);
  });

  it('never copies tool_use payloads: toolCalls input stays out of the snapshot', () => {
    const snap = buildShareSnapshot(
      session,
      [
        msg({
          role: 'assistant',
          content: 'ok',
          toolCalls: [{ id: 'c1', name: 'bash', input: { command: 'cat /secret/INPUT_PAYLOAD' } }],
        }),
      ],
      { ...opts, includeToolNames: true },
    );
    expect(JSON.stringify(snap)).not.toContain('INPUT_PAYLOAD');
  });
});
