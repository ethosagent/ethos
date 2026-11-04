import { describe, expect, it } from 'vitest';
import {
  FIRST_TASK_DEEPWIKI,
  FIRST_TASK_LOOK_AROUND,
  FIRST_TASK_PLAN_WEEK,
  firstTaskChatPath,
  firstTaskSuggestions,
} from '../first-task';

const chatSource = await import('node:fs').then((fs) =>
  fs.readFileSync(new URL('../../pages/Chat.tsx', import.meta.url), 'utf8'),
);

describe('firstTaskSuggestions', () => {
  it('offers only the two always-true lines when nothing connected', () => {
    expect(firstTaskSuggestions([])).toEqual([FIRST_TASK_LOOK_AROUND, FIRST_TASK_PLAN_WEEK]);
  });

  it('adds DeepWiki and Linear lines only when those were connected', () => {
    expect(firstTaskSuggestions(['deepwiki'])).toContain(FIRST_TASK_DEEPWIKI);
    expect(firstTaskSuggestions(['linear'])).toContain('Show my open issues.');
    expect(firstTaskSuggestions(['context7'])).not.toContain(FIRST_TASK_DEEPWIKI);
  });

  it('never exceeds four and keeps "plan my week" last', () => {
    const all = firstTaskSuggestions(['deepwiki', 'linear', 'notion', 'sentry', 'asana']);
    expect(all).toHaveLength(4);
    expect(all.at(-1)).toBe(FIRST_TASK_PLAN_WEEK);
  });
});

describe('first-task prefill (D17)', () => {
  it('builds a chat URL whose ?draft= round-trips the text', () => {
    const path = firstTaskChatPath('sage', FIRST_TASK_DEEPWIKI);
    const [pathname, query] = path.split('?');
    expect(pathname).toBe('/p/sage/chat');
    expect(new URLSearchParams(query).get('draft')).toBe(FIRST_TASK_DEEPWIKI);
  });

  it('Chat fills the composer from ?draft= and never sends it', () => {
    // The pre-existing hand-off the recipe panel uses: `handleSuggestPrompt`
    // fills the draft; there is no sendMessage in the draft effect.
    const effect = chatSource.slice(
      chatSource.indexOf("const draftParam = searchParams.get('draft');"),
      chatSource.indexOf('const { intakeOpen'),
    );
    expect(effect).toContain('handleSuggestPrompt(draftParam)');
    expect(effect).not.toContain('sendMessage');
  });
});
