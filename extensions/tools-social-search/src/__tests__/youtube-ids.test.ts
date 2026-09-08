import { describe, expect, it } from 'vitest';
import { parseYouTubeVideoId } from '../index';

const ID = 'dQw4w9WgXcQ';

describe('parseYouTubeVideoId — accepted forms', () => {
  it.each([
    ['bare id', ID, ID],
    ['watch URL', `https://youtube.com/watch?v=${ID}`, ID],
    ['www host', `https://www.youtube.com/watch?v=${ID}`, ID],
    ['m host', `https://m.youtube.com/watch?v=${ID}`, ID],
    ['extra query param before v=', `https://www.youtube.com/watch?feature=share&v=${ID}`, ID],
    ['extra query param after v=', `https://www.youtube.com/watch?v=${ID}&t=42s`, ID],
    ['youtu.be short link', `https://youtu.be/${ID}`, ID],
    ['youtu.be with query', `https://youtu.be/${ID}?t=42`, ID],
    ['shorts URL', `https://www.youtube.com/shorts/${ID}`, ID],
    ['live URL', `https://www.youtube.com/live/${ID}`, ID],
    ['embed URL', `https://www.youtube.com/embed/${ID}`, ID],
    ['URL with fragment', `https://www.youtube.com/watch?v=${ID}#t=30`, ID],
  ])('%s', (_label, input, expected) => {
    expect(parseYouTubeVideoId(input)).toBe(expected);
  });
});

describe('parseYouTubeVideoId — malformed input', () => {
  it.each([
    ['empty string', ''],
    ['whitespace', '   '],
    ['10-character id', 'abcdefghij'],
    ['12-character id', 'abcdefghijkl'],
    ['watch with no v', 'https://www.youtube.com/watch'],
    ['playlist URL', 'https://www.youtube.com/playlist?list=PL1234567890'],
    ['channel URL', 'https://www.youtube.com/channel/UC1234567890abcdefghij'],
    ['non-URL sentence', 'this is not a url at all'],
    ['javascript: scheme', `javascript:alert(1)`],
  ])('%s -> null', (_label, input) => {
    expect(parseYouTubeVideoId(input)).toBeNull();
  });
});
