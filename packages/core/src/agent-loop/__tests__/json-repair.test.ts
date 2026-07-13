import { describe, expect, it } from 'vitest';
import { repairJson } from '../json-repair';

describe('repairJson', () => {
  describe('valid JSON passes through untouched', () => {
    const valid: Array<[string, unknown]> = [
      ['{}', {}],
      ['{"a":1}', { a: 1 }],
      ['{"path":"/usr/bin","n":42}', { path: '/usr/bin', n: 42 }],
      ['[1,2,3]', [1, 2, 3]],
      ['{"nested":{"x":[true,false,null]}}', { nested: { x: [true, false, null] } }],
      // Unusual-but-valid: a colon inside a string value must survive.
      ['{"url":"http://x:8080/p","t":"12:00"}', { url: 'http://x:8080/p', t: '12:00' }],
      // A comma inside a string value must survive.
      ['{"csv":"a,b,c"}', { csv: 'a,b,c' }],
      ['{"quote":"she said \\"hi\\""}', { quote: 'she said "hi"' }],
    ];
    it.each(valid)('parses %s', (input, expected) => {
      const result = repairJson(input);
      expect(result).toEqual({ ok: true, value: expected });
    });
  });

  describe('repairable malformed JSON', () => {
    const repairable: Array<[string, unknown]> = [
      // Prose before the object (dominant local-model failure mode).
      ['Sure! Here you go: {"file":"a.txt"}', { file: 'a.txt' }],
      // Prose after the object.
      ['{"file":"a.txt"} — let me know if that works', { file: 'a.txt' }],
      // Prose on both sides.
      ['The args are {"n":1} okay?', { n: 1 }],
      // Trailing comma in an object.
      ['{"a":1,"b":2,}', { a: 1, b: 2 }],
      // Trailing comma in an array.
      ['{"xs":[1,2,3,]}', { xs: [1, 2, 3] }],
      // Single-quoted strings.
      ["{'name':'ethos'}", { name: 'ethos' }],
      // Unquoted keys.
      ['{foo: 1, bar: 2}', { foo: 1, bar: 2 }],
      // Combination: prose + single quotes + trailing comma + unquoted keys.
      ["I'll call it with {path: '/tmp/x', force: true,}", { path: '/tmp/x', force: true }],
      // Array at the top level wrapped in prose.
      ['Result: [1, 2, 3,]', [1, 2, 3]],
      // Fenced code block around the JSON.
      ['```json\n{"q":"hi"}\n```', { q: 'hi' }],
    ];
    it.each(repairable)('repairs %s', (input, expected) => {
      const result = repairJson(input);
      expect(result).toEqual({ ok: true, value: expected });
    });
  });

  describe('genuinely broken input returns ok:false', () => {
    const broken = [
      '',
      '   ',
      'not json at all',
      'the function returns a value',
      '{"a": ', // unbalanced — no closing brace
      '{"a": 1', // unbalanced
    ];
    it.each(broken)('rejects %j', (input) => {
      const result = repairJson(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(typeof result.reason).toBe('string');
    });
  });
});
