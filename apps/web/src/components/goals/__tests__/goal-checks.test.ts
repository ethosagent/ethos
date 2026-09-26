// @vitest-environment jsdom
//
// The goal detail page (pages/GoalDetail.tsx) renders a goal's checks through
// GoalChecks, so a host verify command is always visible to the operator.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoalChecks, parseGoalChecks } from '../GoalChecks';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('GoalChecks', () => {
  it('shows each check and its command in mono', () => {
    act(() =>
      root.render(
        createElement(GoalChecks, {
          acceptanceCriteria: {
            checks: [
              { id: 'check-0', description: 'tests pass', command: 'pnpm test' },
              { id: 'check-1', description: 'readme updated' },
            ],
            rubric: [],
            threshold: 0.8,
          },
        }),
      ),
    );
    expect(container.textContent).toContain('tests pass');
    expect(container.textContent).toContain('readme updated');
    expect(container.textContent).toContain('$ pnpm test');
    const mono = [...container.querySelectorAll<HTMLDivElement>('div')].find(
      (d) => d.textContent === '$ pnpm test',
    );
    expect(mono?.style.fontFamily).toContain('Geist Mono');
  });

  it('renders nothing for a goal with no checks or an unrecognised shape', () => {
    act(() => root.render(createElement(GoalChecks, { acceptanceCriteria: null })));
    expect(container.textContent).toBe('');
    expect(parseGoalChecks({ checks: 'nope' })).toEqual([]);
    expect(parseGoalChecks({ checks: [], rubric: [] })).toEqual([]);
  });
});
