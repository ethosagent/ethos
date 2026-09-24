// RFC 6238 TOTP (plan reach-and-containment D4-7). The vectors are RFC 6238
// Appendix B verbatim: 8 digits, 30 s step, one ASCII key per algorithm.

import { describe, expect, it } from 'vitest';
import { decodeBase32, parseTotpSeed, TotpSeedError, totpCode, totpFromParams } from '../totp';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

const KEYS = {
  SHA1: Buffer.from('12345678901234567890', 'ascii'),
  SHA256: Buffer.from('12345678901234567890123456789012', 'ascii'),
  SHA512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii'),
} as const;

// [unix seconds, SHA1, SHA256, SHA512]
const VECTORS: Array<[number, string, string, string]> = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];

describe('RFC 6238 Appendix B', () => {
  for (const [t, sha1, sha256, sha512] of VECTORS) {
    it(`T=${t}`, () => {
      const at = t * 1000;
      expect(totpFromParams({ key: KEYS.SHA1, algorithm: 'SHA1', digits: 8, period: 30 }, at)).toBe(
        sha1,
      );
      expect(
        totpFromParams({ key: KEYS.SHA256, algorithm: 'SHA256', digits: 8, period: 30 }, at),
      ).toBe(sha256);
      expect(
        totpFromParams({ key: KEYS.SHA512, algorithm: 'SHA512', digits: 8, period: 30 }, at),
      ).toBe(sha512);
    });
  }

  it('the same vectors through otpauth:// URIs', () => {
    for (const [t, sha1, sha256, sha512] of VECTORS) {
      const at = t * 1000;
      const uri = (alg: keyof typeof KEYS) =>
        `otpauth://totp/Example:alice?secret=${encodeBase32(KEYS[alg])}&algorithm=${alg}&digits=8&period=30&issuer=Example`;
      expect(totpCode(uri('SHA1'), at)).toBe(sha1);
      expect(totpCode(uri('SHA256'), at)).toBe(sha256);
      expect(totpCode(uri('SHA512'), at)).toBe(sha512);
    }
  });

  it('a bare base32 seed uses the defaults: SHA-1, 6 digits, 30 s', () => {
    // The 6-digit code is the last six digits of the 8-digit SHA-1 vector.
    const seed = encodeBase32(KEYS.SHA1);
    expect(totpCode(seed, 59_000)).toBe('287082');
    expect(totpCode(seed.toLowerCase().replace(/(.{4})/g, '$1 '), 59_000)).toBe('287082');
  });
});

describe('parseTotpSeed', () => {
  it('honours algorithm, digits and period from an otpauth URI', () => {
    const p = parseTotpSeed(
      `otpauth://totp/x?secret=${encodeBase32(KEYS.SHA256)}&algorithm=SHA256&digits=8&period=60`,
    );
    expect(p.algorithm).toBe('SHA256');
    expect(p.digits).toBe(8);
    expect(p.period).toBe(60);
    expect(p.key.equals(KEYS.SHA256)).toBe(true);
  });

  it('defaults an otpauth URI that omits the parameters', () => {
    const p = parseTotpSeed(`otpauth://totp/x?secret=${encodeBase32(KEYS.SHA1)}`);
    expect(p).toMatchObject({ algorithm: 'SHA1', digits: 6, period: 30 });
  });

  const secret = encodeBase32(KEYS.SHA1);
  const refused: Array<[string, string]> = [
    ['HOTP', `otpauth://hotp/x?secret=${secret}&counter=1`],
    ['MD5', `otpauth://totp/x?secret=${secret}&algorithm=MD5`],
    ['7 digits', `otpauth://totp/x?secret=${secret}&digits=7`],
    ['period 0', `otpauth://totp/x?secret=${secret}&period=0`],
    ['period 1.5', `otpauth://totp/x?secret=${secret}&period=1.5`],
    ['period too long', `otpauth://totp/x?secret=${secret}&period=3600`],
    ['unknown parameter', `otpauth://totp/x?secret=${secret}&counter=4`],
    ['no secret', 'otpauth://totp/x?issuer=Example'],
    ['not base32', 'not-base32-!!'],
    ['empty', '   '],
  ];
  for (const [label, input] of refused) {
    it(`refuses ${label}`, () => {
      expect(() => parseTotpSeed(input)).toThrow(TotpSeedError);
    });
  }

  it('never quotes the seed in its error', () => {
    const seed = 'JBSWY3DPEHPK3PXP';
    try {
      parseTotpSeed(`otpauth://totp/x?secret=${seed}&digits=9`);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(seed);
    }
  });

  it('decodeBase32 ignores padding and case', () => {
    expect(decodeBase32('mzxw6===').toString('ascii')).toBe('foo');
  });
});
