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
// with no terminator).
//
// V3-10: the check is a SCALING one, not a wall-clock budget, so it holds on a
// loaded CI box. Each input is built at size n and 4n; after a warm-up, the
// fastest of 5 interleaved runs at each size (`fastestPair`) must satisfy
// t(4n) < 8·t(n) + 5ms. Linear growth is ~4x, quadratic ~16x, and load slows
// both sizes alike, so the ratio survives it where an absolute 50ms budget did
// not. A ratio miss is re-measured up to ATTEMPTS times: noise does not
// repeat, superlinearity does. One generous absolute ceiling (CEILING_MS for
// any single run; the largest input is 400k chars) still catches a blowup
// outright, and the first run past it ends the case, so a quadratic pattern
// fails in seconds instead of minutes. Checked against the round-1 lookbehind
// rule and the pre-V-ES-2 PEM rule: both fail here.
const N = 20_000;
const RUNS = 5;
const ATTEMPTS = 3;
const CEILING_MS = 2_000;

function fill(unit: string, prefix = '', suffix = '', n = N): string {
  return prefix + unit.repeat(Math.ceil(n / unit.length)) + suffix;
}

const ADVERSARIAL: Array<[string, (n: number) => string]> = [
  ['n spaces', (n) => fill(' ', '', '', n)],
  ['n tabs', (n) => fill('\t', '', '', n)],
  ['n newlines', (n) => fill('\n', '', '', n)],
  ['mixed whitespace', (n) => fill(' \t', '', '', n)],
  ['secret name then n spaces', (n) => fill(' ', 'DISCORD_BOT_TOKEN', '=', n)],
  ['secret name, = then n spaces', (n) => fill(' ', 'API_KEY=', '', n)],
  ['n tabs after =', (n) => fill('\t', 'x=', '', n)],
  ['JSON secret key then n spaces', (n) => fill(' ', '"token":', '', n)],
  ['JSON secret key then n newlines', (n) => fill('\n', '"api_key":', '', n)],
  ['JSON secret key, unterminated value', (n) => fill('a', '"token": "', '', n)],
  ['repeated JSON secret keys', (n) => fill('"x_api_key": ', '', '', n)],
  ['repeated secret assignments', (n) => fill('A_TOKEN= ', '', '', n)],
  ['long UPPER_SNAKE run', (n) => fill('A_', '', '', n)],
  ['padded lines', (n) => fill(`x${' '.repeat(2000)}\n`, '', '', n)],
  ['lowercase assignment then spaces', (n) => fill(' ', 'db_password:', '', n)],
  ['lowercase prefix run', (n) => fill('a_', '', '', n)],
  ['repeated query params', (n) => fill('?access_token=', '', '', n)],
  ['repeated npmrc keys', (n) => fill(':_authToken=', '', '', n)],
  ['repeated aws lines', (n) => fill('aws_secret_access_key = ', '', '', n)],
  ['repeated JWT heads', (n) => fill('eyJ-', '', '', n)],
  ['repeated JWT heads with dots', (n) => fill('eyJaaaaaaaa.', '', '', n)],
  // 5x the base size, because n of these took only ~11ms while still
  // quadratic.
  ['PEM headers with no END', (n) => fill('-----BEGIN RSA PRIVATE KEY-----\n', '', '', n * 5)],
  ['Bearer then n spaces', (n) => fill(' ', 'Bearer', '', n)],
  ['repeated Bearer', (n) => fill('Bearer ', '', '', n)],
  ['repeated Discord first segments', (n) => fill('Maaaaaaaaaaaaaaaaaaaaaaaaa.', '', '', n)],
  [
    'Discord first two segments repeated',
    (n) => fill('Maaaaaaaaaaaaaaaaaaaaaaaaa.abcdef.', '', '', n),
  ],
  ['repeated Telegram ids', (n) => fill('12345678:', '', '', n)],
  ['long dash run after sk-', (n) => fill('-', 'sk-', '', n)],
  ['dotted words (email local part)', (n) => fill('a.', '', '', n)],
  ['dashed words', (n) => fill('a-', '', '', n)],
  ['repeated @', (n) => fill('a@', '', '', n)],
  ['email domain with no TLD', (n) => fill('a.', 'x@', '', n)],
  ['digits with separators', (n) => fill('1 ', '', '', n)],
  ['digit runs', (n) => fill('1', '', '', n)],
  ['IBAN-like run', (n) => fill('AB12', '', '', n)],
  // V2-SEC-4 additions.
  ['secret name, n spaces, then =', (n) => fill(' ', 'db_password', '= x', n)],
  ['repeated aligned assignments', (n) => fill('api_token          = ', '', '', n)],
  ['repeated x-api-key headers', (n) => fill('x-api-key: ', '', '', n)],
  ['Basic then n spaces', (n) => fill(' ', 'Authorization: Basic', '', n)],
  ['repeated Authorization headers', (n) => fill('Authorization: Basic ', '', '', n)],
  ['repeated URL schemes', (n) => fill('a://', '', '', n)],
  ['URL userinfo with no @', (n) => fill('b', 'https://user:', '', n)],
  ['repeated user:pass with no @', (n) => fill('u:p', 'https://', '', n)],
  ['repeated prose secrets', (n) => fill('PASSWORD: required ', '', '', n)],
  // V3-5 / V3-9 additions.
  ['Basic then one unbroken base64 run', (n) => fill('A', 'Authorization: Basic ', '', n)],
  ['repeated Basic with a base64 group', (n) => fill('Authorization: Basic dXNl ', '', '', n)],
  ['placeholder prefix with no _here', (n) => fill('_', 'API_KEY: your_', '', n)],
  ['repeated your_ placeholders', (n) => fill('api_key: your_x_ ', '', '', n)],
  ['repeated empty-user URLs', (n) => fill('r://:', '', '', n)],
  ['repeated templated URLs', (n) => fill(`p://${'$'}{U}:${'$'}{P}`, '', '', n)],
  ['x-run password with no @', (n) => fill('x', 'https://u:', '', n)],
];

function timeMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

/**
 * The fastest of RUNS timings of `small` and of `large`, taken interleaved so
 * a burst of load lands on both sizes rather than on one. The minimum, not the
 * median: noise (another worker, a GC pause) only ever ADDS time, and the
 * median of 5 still failed here when parallel test files ran beside it, while
 * a quadratic pattern's fastest run is still quadratic. Stops at the first run
 * past CEILING_MS so a blowup fails at once.
 */
function fastestPair(small: () => void, large: () => void): { tSmall: number; tLarge: number } {
  let tSmall = Number.POSITIVE_INFINITY;
  let tLarge = Number.POSITIVE_INFINITY;
  for (let i = 0; i < RUNS; i++) {
    tSmall = Math.min(tSmall, timeMs(small));
    const t = timeMs(large);
    if (t > CEILING_MS) return { tSmall, tLarge: t };
    tLarge = Math.min(tLarge, t);
  }
  return { tSmall, tLarge };
}

function expectLinear(redact: (s: string) => string, build: (n: number) => string): void {
  const small = build(N);
  const large = build(4 * N);
  // Warm-up: JIT the patterns and size the heap before anything is timed.
  expect(timeMs(() => redact(small))).toBeLessThan(CEILING_MS);
  // Up to ATTEMPTS measurements: on a box at load ~150 a sub-millisecond run
  // can be descheduled for a whole time slice on all 5 tries. A superlinear
  // pattern fails every attempt; a run past the ceiling fails at once.
  let last = { tSmall: 0, tLarge: Number.POSITIVE_INFINITY };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    last = fastestPair(
      () => redact(small),
      () => redact(large),
    );
    expect(last.tLarge).toBeLessThan(CEILING_MS);
    if (last.tLarge < 8 * last.tSmall + 5) return;
  }
  expect(last.tLarge).toBeLessThan(8 * last.tSmall + 5);
}

describe('redaction is linear on adversarial input (V-ES-2, V3-10)', () => {
  it.each(ADVERSARIAL)('redactString: %s', (_name, build) => {
    expectLinear(redactString, build);
  });

  it.each(ADVERSARIAL)('redactPii: %s', (_name, build) => {
    expectLinear(redactPii, build);
  });
});
