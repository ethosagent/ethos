import { describe, expect, it } from 'vitest';
import { parseDeepLink, parseOsLink } from '../deep-link';

describe('parseDeepLink', () => {
  it('parses a valid connect link', () => {
    expect(
      parseDeepLink('ethos://connect?url=http%3A%2F%2F192.168.1.5%3A3000%2F&key=sk-ethos-abc123'),
    ).toEqual({ kind: 'connect', url: 'http://192.168.1.5:3000', key: 'sk-ethos-abc123' });
  });

  it('rejects invalid connect links', () => {
    expect(parseDeepLink('ethos://connect?url=http%3A%2F%2Fa.b&key=abc')).toBeNull();
    expect(parseDeepLink('ethos://connect?url=http%3A%2F%2Fa.b')).toBeNull();
    expect(parseDeepLink('ethos://connect?url=ftp%3A%2F%2Fx&key=sk-ethos-1')).toBeNull();
    expect(parseDeepLink('ethos://connect?key=sk-ethos-1')).toBeNull();
  });

  it('parses a chat link without session', () => {
    expect(parseDeepLink('ethos://p/engineer/chat')).toEqual({
      kind: 'chat',
      personalityId: 'engineer',
    });
  });

  it('parses a chat link with session', () => {
    expect(parseDeepLink('ethos://p/engineer/chat?session=s-42')).toEqual({
      kind: 'chat',
      personalityId: 'engineer',
      sessionId: 's-42',
    });
  });

  it('parses a task link', () => {
    expect(parseDeepLink('ethos://t/marketing/task/MKT-38')).toEqual({
      kind: 'task',
      team: 'marketing',
      taskId: 'MKT-38',
    });
  });

  it('decodes percent-encoded segments', () => {
    expect(parseDeepLink('ethos://p/my%20agent/chat')).toEqual({
      kind: 'chat',
      personalityId: 'my agent',
    });
  });

  it.each([
    '',
    'https://example.com',
    'ETHOS://p/x/chat',
    'ethos://',
    'ethos://p/engineer',
    'ethos://p/engineer/chat/',
    'ethos://p//chat',
    'ethos://t/marketing/task',
    'ethos://x/y',
    'ethos://p/%E0%A4%A/chat',
    'ethos://connect/extra?url=http%3A%2F%2Fa&key=sk-ethos-1',
  ])('returns null for malformed link %s', (raw) => {
    expect(parseDeepLink(raw)).toBeNull();
  });
});

describe('parseOsLink', () => {
  it('refuses connect links', () => {
    const raw = 'ethos://connect?url=http%3A%2F%2Fa.b&key=sk-ethos-1';
    expect(parseOsLink(raw)).toBeNull();
    expect(parseDeepLink(raw)).not.toBeNull();
  });

  it('passes through chat links', () => {
    expect(parseOsLink('ethos://p/engineer/chat?session=s1')).toEqual({
      kind: 'chat',
      personalityId: 'engineer',
      sessionId: 's1',
    });
  });
});
