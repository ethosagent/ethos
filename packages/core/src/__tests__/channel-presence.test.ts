import { describe, expect, it } from 'vitest';
import { mentionsPersonalityName } from '../channel-presence';

// Plan personality-presence-and-initiative §3 (mention by name): a group
// message "addresses" the bot when it names the bound personality as a whole
// word, case-insensitively, with the name's regex metacharacters escaped.

describe('mentionsPersonalityName', () => {
  it('matches the name as a whole word, any case', () => {
    expect(mentionsPersonalityName('hey Owl, what time is it?', 'Owl')).toBe(true);
    expect(mentionsPersonalityName('OWL help', 'Owl')).toBe(true);
    expect(mentionsPersonalityName('ask owl.', 'Owl')).toBe(true);
  });

  it('does not match a name inside a longer word', () => {
    expect(mentionsPersonalityName('that is Owlish of you', 'Owl')).toBe(false);
    expect(mentionsPersonalityName('a Barnowl flew by', 'Owl')).toBe(false);
    expect(mentionsPersonalityName('owl_bot is here', 'Owl')).toBe(false);
  });

  it('escapes regex metacharacters in the name', () => {
    expect(mentionsPersonalityName('ping C++ please', 'C++')).toBe(true);
    expect(mentionsPersonalityName('ping CCC please', 'C++')).toBe(false);
    expect(mentionsPersonalityName('hi Dr. Owl', 'Dr. Owl')).toBe(true);
    expect(mentionsPersonalityName('hi Drx Owl', 'Dr. Owl')).toBe(false);
  });

  it('treats non-ASCII letters as word characters', () => {
    expect(mentionsPersonalityName('bonjour Émile', 'Émile')).toBe(true);
    expect(mentionsPersonalityName('bonjour Émilee', 'Émile')).toBe(false);
  });

  it('matches José whether the text or the name is composed or decomposed', () => {
    const composed = 'José';
    const decomposed = 'José';
    expect(mentionsPersonalityName(`hola ${composed}!`, composed)).toBe(true);
    expect(mentionsPersonalityName(`hola ${decomposed}!`, composed)).toBe(true);
    expect(mentionsPersonalityName(`hola ${composed}!`, decomposed)).toBe(true);
    expect(mentionsPersonalityName(`hola ${decomposed}!`, decomposed)).toBe(true);
  });

  it('treats a combining mark as part of the word', () => {
    // "Jose" + U+0301 is "José", not "Jose" followed by a boundary.
    expect(mentionsPersonalityName('hola José', 'Jose')).toBe(false);
    // A mark the NFC form cannot absorb (U+0331 on "e") still binds.
    expect(mentionsPersonalityName('hola Jose̱', 'Jose')).toBe(false);
    expect(mentionsPersonalityName('hola ̱Jose', 'Jose')).toBe(false);
    expect(mentionsPersonalityName('hola Jose, qué tal', 'Jose')).toBe(true);
  });

  it('never matches a blank name', () => {
    expect(mentionsPersonalityName('anything at all', '')).toBe(false);
    expect(mentionsPersonalityName('anything at all', '   ')).toBe(false);
  });
});
