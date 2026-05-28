import { describe, expect, it } from 'vitest';
import { redactJson, redactString } from '../redact';

describe('redactString', () => {
  it('redacts GitHub PAT (ghp_ prefix)', () => {
    const pat = `ghp_${'A'.repeat(36)}`;
    expect(redactString(pat)).toBe('[REDACTED:github-pat]');
  });
  it('redacts GitHub fine-grained PAT (github_pat_ prefix)', () => {
    const pat = `github_pat_${'A'.repeat(82)}`;
    expect(redactString(pat)).toBe('[REDACTED:github-pat]');
  });
  it('redacts Anthropic key', () => {
    const key = `sk-ant-${'A'.repeat(93)}`;
    expect(redactString(key)).toBe('[REDACTED:anthropic-key]');
  });
  it('redacts OpenAI key', () => {
    const key = `sk-${'A'.repeat(40)}`;
    expect(redactString(key)).toBe('[REDACTED:openai-key]');
  });
  it('redacts OpenAI project key', () => {
    const key = `sk-proj-${'A'.repeat(40)}`;
    expect(redactString(key)).toBe('[REDACTED:openai-key]');
  });
  it('redacts AWS access key', () => {
    const key = `AKIA${'A'.repeat(16)}`;
    expect(redactString(key)).toBe('[REDACTED:aws-key]');
  });
  it('redacts Stripe live key', () => {
    const key = `sk_live_${'A'.repeat(24)}`;
    expect(redactString(key)).toBe('[REDACTED:stripe-key]');
  });
  it('redacts Slack token', () => {
    const tok = `xoxb-${'1'.repeat(10)}-${'2'.repeat(10)}-${'A'.repeat(24)}`;
    expect(redactString(tok)).toBe('[REDACTED:slack-token]');
  });
  it('redacts all generic secret keywords (key=, token=, secret=, password=)', () => {
    const val = 'A'.repeat(20);
    expect(redactString(`key=${val}`)).toBe('[REDACTED:generic-secret]');
    expect(redactString(`token=${val}`)).toBe('[REDACTED:generic-secret]');
    expect(redactString(`secret=${val}`)).toBe('[REDACTED:generic-secret]');
    expect(redactString(`password=${val}`)).toBe('[REDACTED:generic-secret]');
  });
  it('redacts generic secret with quoted value', () => {
    const val = 'A'.repeat(20);
    expect(redactString(`key="${val}"`)).toBe('[REDACTED:generic-secret]');
    expect(redactString(`password='${val}'`)).toBe('[REDACTED:generic-secret]');
  });
  it('does not redact short values (below 20-char threshold)', () => {
    expect(redactString('key=short')).toBe('key=short');
    expect(redactString('password=tooshort')).toBe('password=tooshort');
  });
  it('leaves clean strings unchanged', () => {
    expect(redactString('hello world')).toBe('hello world');
    expect(redactString('')).toBe('');
  });
  it('redacts multiple occurrences', () => {
    const key1 = `AKIA${'A'.repeat(16)}`;
    const key2 = `AKIA${'B'.repeat(16)}`;
    const result = redactString(`${key1} and ${key2}`);
    expect(result).toBe('[REDACTED:aws-key] and [REDACTED:aws-key]');
  });
});
describe('redactJson', () => {
  it('redacts string values deeply', () => {
    const key = `AKIA${'A'.repeat(16)}`;
    const obj = { nested: { secret: key } };
    const result = redactJson(obj);
    expect(result.nested.secret).toBe('[REDACTED:aws-key]');
  });
  it('leaves non-string values unchanged', () => {
    const obj = { count: 42, flag: true, nothing: null };
    const result = redactJson(obj);
    expect(result.count).toBe(42);
    expect(result.flag).toBe(true);
    expect(result.nothing).toBeNull();
  });
  it('handles arrays within objects', () => {
    const key = `AKIA${'A'.repeat(16)}`;
    const obj = { keys: [key, 'clean'] };
    const result = redactJson(obj);
    expect(result.keys[0]).toBe('[REDACTED:aws-key]');
    expect(result.keys[1]).toBe('clean');
  });
});
