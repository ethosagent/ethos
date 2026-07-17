import { describe, expect, it } from 'vitest';
import { redactErrorMessage } from '../redact-error';

describe('redactErrorMessage', () => {
  it('strips a known literal secret from the message', () => {
    const key = 'sk-ant-supersecret-abcdef0123456789';
    const out = redactErrorMessage(`auth failed with ${key} on retry`, key);
    expect(out).not.toContain(key);
    expect(out).toContain('[redacted]');
  });

  it('redacts a Gemini-style ?key= query param even without the literal', () => {
    const out = redactErrorMessage('GET https://x/v1?key=AIzaSyXXXXXXXXXXXXXXXXXXXX failed');
    expect(out).not.toContain('AIzaSyXXXXXXXXXXXXXXXXXXXX');
    expect(out).toContain('key=[redacted]');
  });

  it('redacts a Bearer token', () => {
    const out = redactErrorMessage('401 with header Authorization: Bearer xoxb-abcdef-123456');
    expect(out).not.toContain('xoxb-abcdef-123456');
    expect(out).toContain('Bearer [redacted]');
  });

  it('ignores short/empty secrets so it cannot blank the whole message', () => {
    expect(redactErrorMessage('plain error text', '', 'ab')).toBe('plain error text');
  });
});
