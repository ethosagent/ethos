import { describe, expect, it } from 'vitest';
import { redactPii, redactString } from '../index';

// V-ES-2 (plan upstream-bug-parity, fix round 1). redactString runs
// synchronously on every tool result and on the memory snapshot, so a pattern
// that is superlinear on some input lets an attacker-controlled page or file
// stall the event loop for every bot and lane in the process. The
// secret-named-value rule once used an unbounded variable-length lookbehind,
// which re-scanned every whitespace run backwards at every position: 100k
// spaces took ~15s. Every input below is shaped to hit one pattern's worst
// case (a long run the pattern's quantifier accepts, repeated starts, a prefix
// with no terminator); each must redact in well under the budget.
//
// The budget is deliberately loose (a linear pass over 100k chars is ~2ms) so
// a slow CI box does not flake, and a retry absorbs one GC pause; a quadratic
// pattern misses it by orders of magnitude, not by a few milliseconds.
const BUDGET_MS = 50;
const N = 100_000;

function fill(unit: string, prefix = '', suffix = '', n = N): string {
  return prefix + unit.repeat(Math.ceil(n / unit.length)) + suffix;
}

const ADVERSARIAL: Array<[string, string]> = [
  ['100k spaces', fill(' ')],
  ['100k tabs', fill('\t')],
  ['100k newlines', fill('\n')],
  ['mixed whitespace', fill(' \t')],
  ['secret name then 100k spaces', fill(' ', 'DISCORD_BOT_TOKEN', '=')],
  ['secret name, = then 100k spaces', fill(' ', 'API_KEY=')],
  ['100k tabs after =', fill('\t', 'x=')],
  ['JSON secret key then 100k spaces', fill(' ', '"token":')],
  ['JSON secret key then 100k newlines', fill('\n', '"api_key":')],
  ['JSON secret key, unterminated value', fill('a', '"token": "')],
  ['repeated JSON secret keys', fill('"x_api_key": ')],
  ['repeated secret assignments', fill('A_TOKEN= ')],
  ['long UPPER_SNAKE run', fill('A_')],
  ['padded lines', fill(`x${' '.repeat(2000)}\n`)],
  ['lowercase assignment then spaces', fill(' ', 'db_password:')],
  ['lowercase prefix run', fill('a_')],
  ['repeated query params', fill('?access_token=')],
  ['repeated npmrc keys', fill(':_authToken=')],
  ['repeated aws lines', fill('aws_secret_access_key = ')],
  ['repeated JWT heads', fill('eyJ-')],
  ['repeated JWT heads with dots', fill('eyJaaaaaaaa.')],
  // 500k, because 100k of these took only ~11ms while still quadratic.
  ['PEM headers with no END', fill('-----BEGIN RSA PRIVATE KEY-----\n', '', '', 500_000)],
  ['Bearer then 100k spaces', fill(' ', 'Bearer')],
  ['repeated Bearer', fill('Bearer ')],
  ['repeated Discord first segments', fill('Maaaaaaaaaaaaaaaaaaaaaaaaa.')],
  ['Discord first two segments repeated', fill('Maaaaaaaaaaaaaaaaaaaaaaaaa.abcdef.')],
  ['repeated Telegram ids', fill('12345678:')],
  ['long dash run after sk-', fill('-', 'sk-')],
  ['dotted words (email local part)', fill('a.')],
  ['dashed words', fill('a-')],
  ['repeated @', fill('a@')],
  ['email domain with no TLD', fill('a.', 'x@')],
  ['digits with separators', fill('1 ')],
  ['digit runs', fill('1')],
  ['IBAN-like run', fill('AB12')],
  // V2-SEC-4 additions.
  ['secret name, 100k spaces, then =', fill(' ', 'db_password', '= x')],
  ['repeated aligned assignments', fill('api_token          = ')],
  ['repeated x-api-key headers', fill('x-api-key: ')],
  ['Basic then 100k spaces', fill(' ', 'Authorization: Basic')],
  ['repeated Authorization headers', fill('Authorization: Basic ')],
  ['repeated URL schemes', fill('a://')],
  ['URL userinfo with no @', fill('b', 'https://user:')],
  ['repeated user:pass with no @', fill('u:p', 'https://')],
  ['repeated prose secrets', fill('PASSWORD: required ')],
];

function timeMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function bestOfTwo(fn: () => void): number {
  const first = timeMs(fn);
  return first < BUDGET_MS ? first : Math.min(first, timeMs(fn));
}

describe('redaction is linear on adversarial input (V-ES-2)', () => {
  it.each(ADVERSARIAL)('redactString: %s', (_name, input) => {
    expect(bestOfTwo(() => redactString(input))).toBeLessThan(BUDGET_MS);
  });

  it.each(ADVERSARIAL)('redactPii: %s', (_name, input) => {
    expect(bestOfTwo(() => redactPii(input))).toBeLessThan(BUDGET_MS);
  });
});
