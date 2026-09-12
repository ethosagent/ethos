import { describe, expect, it } from 'vitest';
import { type ContentHashInput, canonicalizeContent, computeContentHash } from '../hash';

const BASE: ContentHashInput = {
  personalityId: 'cmo',
  botKey: 'bot-marketing',
  platform: 'telegram',
  chatId: '-1001234567890',
  threadId: null,
  text: 'Ethos 0.9 ships today.',
};

describe('canonicalizeContent', () => {
  it('emits keys in sorted order with v:1 last', () => {
    expect(canonicalizeContent(BASE)).toBe(
      '{"botKey":"bot-marketing","chatId":"-1001234567890","personalityId":"cmo",' +
        '"platform":"telegram","text":"Ethos 0.9 ships today.","threadId":null,"v":1}',
    );
  });

  it('does not depend on the order the caller built the object in', () => {
    const shuffled: ContentHashInput = {
      text: BASE.text,
      chatId: BASE.chatId,
      platform: BASE.platform,
      botKey: BASE.botKey,
      threadId: BASE.threadId,
      personalityId: BASE.personalityId,
    };
    expect(canonicalizeContent(shuffled)).toBe(canonicalizeContent(BASE));
  });

  it('encodes an absent thread as null, the same as an explicit null', () => {
    const { threadId: _omitted, ...withoutThread } = BASE;
    expect(computeContentHash(withoutThread)).toBe(computeContentHash(BASE));
    expect(computeContentHash({ ...BASE, threadId: undefined })).toBe(computeContentHash(BASE));
  });
});

describe('computeContentHash — golden vector', () => {
  it('pins the v:1 encoding', () => {
    // A COMMITTED literal, not a recomputation. Changing the canonical form
    // changes every hash in every live `outbox.db`: an approval recorded before
    // the change stops matching its own item, and every pending publication
    // fails its binding check. If this assertion has to move, the encoding
    // needs a `v:2` and a migration, not a new number here.
    expect(computeContentHash(BASE)).toBe(
      '5af02398483436635f0e399def76f489758e709f11e4a2cf869a19a5d72c811c',
    );
  });
});

describe('computeContentHash — every bound field is bound', () => {
  const variants: Array<[string, ContentHashInput]> = [
    ['personalityId', { ...BASE, personalityId: 'cto' }],
    ['botKey', { ...BASE, botKey: 'bot-support' }],
    ['platform', { ...BASE, platform: 'slack' }],
    ['chatId', { ...BASE, chatId: '-1009999999999' }],
    ['threadId', { ...BASE, threadId: '42' }],
    ['text', { ...BASE, text: 'Ethos 0.9 ships tomorrow.' }],
  ];

  it.each(variants)('changing %s changes the hash', (_field, variant) => {
    expect(computeContentHash(variant)).not.toBe(computeContentHash(BASE));
  });

  it('treats text as byte-exact — no trimming, no normalization', () => {
    // The approver approved the bytes they were shown. A trailing newline that
    // the store quietly dropped would mean the delivered text differs from the
    // reviewed text without the hash noticing.
    expect(computeContentHash({ ...BASE, text: `${BASE.text}\n` })).not.toBe(
      computeContentHash(BASE),
    );
    expect(computeContentHash({ ...BASE, text: ` ${BASE.text}` })).not.toBe(
      computeContentHash(BASE),
    );
  });

  it('distinguishes an empty thread id from no thread', () => {
    // The store normalizes '' to NULL before it ever reaches here, so this only
    // pins that the hash itself does not silently conflate the two.
    expect(computeContentHash({ ...BASE, threadId: '' })).not.toBe(computeContentHash(BASE));
  });
});
