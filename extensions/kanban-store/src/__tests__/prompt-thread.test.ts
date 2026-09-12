import { describe, expect, it } from 'vitest';
import type { TaskComment, TaskRun } from '../index';
import { renderOperatorContext } from '../prompt-thread';

function comment(author: string, body: string, createdAt: number): TaskComment {
  return { id: `c_${createdAt}_${author}`, taskId: 't_1', author, body, createdAt };
}

function run(overrides: Partial<TaskRun>): TaskRun {
  return {
    id: 'r_1',
    taskId: 't_1',
    startedAt: 1_000,
    endedAt: null,
    outcome: null,
    summary: null,
    lastHeartbeatAt: 1_000,
    completedBy: null,
    ...overrides,
  };
}

describe('renderOperatorContext', () => {
  it('returns an empty string when there is nothing to add', () => {
    expect(renderOperatorContext([], [])).toBe('');
    // Agent comments alone and an open run alone add nothing.
    expect(
      renderOperatorContext([comment('brand-guide', '🔧 read_file({})', 2_000)], [run({})]),
    ).toBe('');
  });

  it('excludes agent-authored comments and keeps human comments in chronological order', () => {
    const out = renderOperatorContext(
      [
        comment('human:control-center', 'second answer', 3_000),
        comment('brand-guide', '🔧 web_fetch({"url":"x"})', 2_500),
        comment('human:operator', 'first answer', 2_000),
        comment('system', 'noise', 2_200),
      ],
      [],
    );
    expect(out).not.toContain('web_fetch');
    expect(out).not.toContain('noise');
    expect(out).toContain(`[${new Date(2_000).toISOString()}] human:operator: first answer`);
    expect(out.indexOf('first answer')).toBeLessThan(out.indexOf('second answer'));
    expect(out).toContain('do not ask again for what they already answered');
  });

  it('includes the summary of the most recent ended run when it ended blocked', () => {
    const out = renderOperatorContext(
      [],
      [
        run({ id: 'r_1', startedAt: 1_000, endedAt: 1_500, outcome: 'blocked', summary: 'old q' }),
        run({
          id: 'r_2',
          startedAt: 2_000,
          endedAt: 2_500,
          outcome: 'blocked',
          summary: 'Which X handle should I read?',
        }),
        run({ id: 'r_3', startedAt: 3_000 }), // the run just claimed — still open
      ],
    );
    expect(out).toContain('Your previous attempt stopped with: Which X handle should I read?');
    expect(out).not.toContain('old q');
    // No human comments → no instruction line about them.
    expect(out).not.toContain('Operator comments above');
  });

  it('omits the summary when the most recent ended run did not end blocked', () => {
    const out = renderOperatorContext(
      [],
      [
        run({ id: 'r_1', startedAt: 1_000, endedAt: 1_500, outcome: 'blocked', summary: 'q' }),
        run({ id: 'r_2', startedAt: 2_000, endedAt: 2_500, outcome: 'cancelled' }),
      ],
    );
    expect(out).toBe('');
  });

  it('keeps only the last 10 human comments and notes the omission', () => {
    const comments = Array.from({ length: 12 }, (_, i) =>
      comment('human:control-center', `answer-${i}`, 1_000 + i),
    );
    const out = renderOperatorContext(comments, []);
    expect(out).not.toMatch(/answer-0$/m);
    expect(out).not.toMatch(/answer-1$/m);
    expect(out).toContain('answer-2');
    expect(out).toContain('answer-11');
    expect(out).toContain('(2 earlier operator comments omitted)');
  });

  it('drops the oldest comments first to stay within the character budget', () => {
    const big = 'x'.repeat(1_500);
    const comments = [
      comment('human:a', `alpha ${big}`, 1_000),
      comment('human:a', `bravo ${big}`, 2_000),
      comment('human:a', `charlie ${big}`, 3_000),
    ];
    const out = renderOperatorContext(comments, []);
    expect(out).not.toContain('alpha');
    expect(out).toContain('bravo');
    expect(out).toContain('charlie');
    expect(out).toContain('(1 earlier operator comment omitted)');
  });

  it('truncates a single over-budget comment rather than dropping it', () => {
    const out = renderOperatorContext([comment('human:a', 'y'.repeat(10_000), 1_000)], []);
    expect(out).toContain('… [truncated]');
    expect(out.length).toBeLessThan(5_000);
  });
});
