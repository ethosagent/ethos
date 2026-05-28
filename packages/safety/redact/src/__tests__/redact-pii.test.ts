import { describe, expect, it } from 'vitest';
import { redactPii } from '../index';

describe('redactPii', () => {
  it('passes clean text through unchanged', () => {
    const clean = 'Hello, this is a normal message with no PII.';
    expect(redactPii(clean)).toBe(clean);
  });

  it('redacts email addresses', () => {
    expect(redactPii('Contact me at user@example.com please')).toBe(
      'Contact me at [REDACTED:email] please',
    );
  });

  it('redacts phone numbers (E.164)', () => {
    const result = redactPii('Call me at +15551234567');
    expect(result).toContain('[REDACTED:phone]');
    expect(result).not.toContain('555');
  });

  it('redacts credit card numbers', () => {
    const result = redactPii('My card is 4111 1111 1111 1111');
    expect(result).toContain('[REDACTED:card]');
    expect(result).not.toContain('4111');
  });

  it('redacts US SSNs', () => {
    expect(redactPii('SSN: 123-45-6789')).toBe('SSN: [REDACTED:ssn]');
  });

  it('redacts IBANs', () => {
    const result = redactPii('Transfer to GB29NWBK60161331926819');
    expect(result).toContain('[REDACTED:iban]');
    expect(result).not.toContain('GB29NWBK');
  });

  it('redacts multiple PII types in one string', () => {
    const input = 'Email: a@b.com, SSN: 123-45-6789';
    const result = redactPii(input);
    expect(result).toContain('[REDACTED:email]');
    expect(result).toContain('[REDACTED:ssn]');
  });

  it('applies extraPatterns', () => {
    const result = redactPii('Reference: CUST-12345-XY', ['CUST-\\d+-[A-Z]+']);
    expect(result).toContain('[REDACTED:custom]');
    expect(result).not.toContain('CUST-12345');
  });

  it('ignores malformed extraPatterns', () => {
    const input = 'Hello world';
    expect(redactPii(input, ['[invalid'])).toBe(input);
  });

  it('is idempotent on consecutive calls', () => {
    const input = 'user@example.com and 123-45-6789';
    const first = redactPii(input);
    const second = redactPii(first);
    expect(first).toBe(second);
  });
});
