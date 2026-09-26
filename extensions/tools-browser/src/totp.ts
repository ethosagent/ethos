// ---------------------------------------------------------------------------
// RFC 6238 TOTP (plan reach-and-containment D4-7)
// ---------------------------------------------------------------------------
//
// `browser_fill_credential` generates a 2FA code from a stored seed so a login
// that asks for one does not need a human. A seed is stored either as a bare
// base32 key (the RFC defaults: SHA-1, 6 digits, 30 s) or as an
// `otpauth://totp/...` URI whose `algorithm` / `digits` / `period` parameters
// are honoured. Anything else is refused by `parseTotpSeed`, which both store
// surfaces (CLI, web) call before writing — so a seed the tool cannot use
// never reaches the vault.
//
// Error messages never quote the seed: they reach the operator's terminal and
// the web form, and a seed IS the second factor.

import { createHmac } from 'node:crypto';

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpParams {
  /** The decoded key bytes. */
  key: Buffer;
  algorithm: TotpAlgorithm;
  digits: 6 | 8;
  /** Step length in seconds. */
  period: number;
}

export class TotpSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TotpSeedError';
  }
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const MAX_PERIOD_S = 300;

/** Decode RFC 4648 base32. Case-insensitive; spaces, dashes and `=` padding ignored. */
export function decodeBase32(input: string): Buffer {
  const clean = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (clean.length === 0) throw new TotpSeedError('TOTP seed is empty.');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new TotpSeedError('TOTP seed is not valid base32.');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (out.length === 0) throw new TotpSeedError('TOTP seed is too short.');
  return Buffer.from(out);
}

function parseAlgorithm(raw: string | null): TotpAlgorithm {
  if (raw === null) return 'SHA1';
  const up = raw.toUpperCase().replace('-', '');
  if (up === 'SHA1' || up === 'SHA256' || up === 'SHA512') return up;
  throw new TotpSeedError('Unsupported TOTP algorithm — use SHA1, SHA256 or SHA512.');
}

function parseDigits(raw: string | null): 6 | 8 {
  if (raw === null) return 6;
  if (raw === '6') return 6;
  if (raw === '8') return 8;
  throw new TotpSeedError('Unsupported TOTP digit count — use 6 or 8.');
}

function parsePeriod(raw: string | null): number {
  if (raw === null) return 30;
  if (!/^\d+$/.test(raw)) throw new TotpSeedError('TOTP period must be a whole number of seconds.');
  const n = Number(raw);
  if (n < 1 || n > MAX_PERIOD_S) {
    throw new TotpSeedError(`TOTP period must be between 1 and ${MAX_PERIOD_S} seconds.`);
  }
  return n;
}

const KNOWN_URI_PARAMS = new Set(['secret', 'issuer', 'algorithm', 'digits', 'period', 'image']);

/**
 * Parse a stored seed: a bare base32 key, or an `otpauth://totp/` URI.
 * Throws {@link TotpSeedError} for anything the generator cannot honour —
 * HOTP (`otpauth://hotp`), an unknown algorithm, a digit count other than 6/8,
 * a non-integer or out-of-range period, an unknown parameter that changes the
 * code (`counter`), or a key that is not base32.
 */
export function parseTotpSeed(input: string): TotpParams {
  const trimmed = input.trim();
  if (!trimmed.toLowerCase().startsWith('otpauth:')) {
    return { key: decodeBase32(trimmed), algorithm: 'SHA1', digits: 6, period: 30 };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TotpSeedError('TOTP URI is not a valid otpauth:// URI.');
  }
  // WHATWG URL puts the otpauth "type" in `host` for special-less schemes
  // (`otpauth://totp/label` → host `totp`).
  if (url.host.toLowerCase() !== 'totp') {
    throw new TotpSeedError('Only time-based otpauth://totp/ URIs are supported.');
  }
  for (const key of url.searchParams.keys()) {
    if (!KNOWN_URI_PARAMS.has(key.toLowerCase())) {
      throw new TotpSeedError(`Unsupported otpauth parameter "${key}".`);
    }
  }
  const secret = url.searchParams.get('secret');
  if (!secret) throw new TotpSeedError('otpauth URI has no secret parameter.');
  return {
    key: decodeBase32(secret),
    algorithm: parseAlgorithm(url.searchParams.get('algorithm')),
    digits: parseDigits(url.searchParams.get('digits')),
    period: parsePeriod(url.searchParams.get('period')),
  };
}

/** RFC 6238 §4 over parsed parameters. `nowMs` is a Unix epoch in milliseconds. */
export function totpFromParams(params: TotpParams, nowMs: number): string {
  const counter = Math.floor(nowMs / 1000 / params.period);
  const msg = Buffer.alloc(8);
  // 64-bit big-endian counter; `writeBigUInt64BE` keeps it exact past 2^32.
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(params.algorithm.toLowerCase(), params.key).update(msg).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  const mod = params.digits === 8 ? 100_000_000 : 1_000_000;
  return String(binary % mod).padStart(params.digits, '0');
}

/** The current code for a stored seed (base32 or otpauth URI). */
export function totpCode(seed: string, nowMs: number): string {
  return totpFromParams(parseTotpSeed(seed), nowMs);
}
