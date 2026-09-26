// @vitest-environment jsdom
//
// The per-check "Verify command" field exists only when the server reports
// `goals.allowCheckCommands: true` (`goals.settings`). A command runs on the
// host when the goal is judged, so with the key off the form adds nothing.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let allow = false;
vi.mock('../../../rpc', () => ({
  rpc: { goals: { settings: () => Promise.resolve({ allowCheckCommands: allow }) } },
}));

const { GoalIntakeModal } = await import('../GoalIntakeModal');

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

async function render(onConfiguredRun = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(GoalIntakeModal, {
          open: true,
          onClose: () => {},
          userMessage: 'make tests pass',
          restatedGoal: 'Make the tests pass',
          onQuickStart: () => {},
          onConfiguredRun,
        }),
      ),
    );
  });
  // Open "Configure & run".
  const configure = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Configure'),
  );
  await act(async () => configure?.click());
  return onConfiguredRun;
}

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('GoalIntakeModal — verify command', () => {
  it('shows no command field when check commands are disabled', async () => {
    allow = false;
    const onRun = await render();
    expect(container.querySelector('input[aria-label="Verify command"]')).toBeNull();
    expect(container.textContent).not.toContain('exits 0');

    const desc = container.querySelector<HTMLInputElement>('input[placeholder="Description"]');
    if (!desc) throw new Error('no description input');
    await act(async () => setInput(desc, 'tests pass'));
    const run = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Run goal');
    await act(async () => run?.click());
    expect(onRun.mock.calls[0]?.[0].checks).toEqual([{ description: 'tests pass' }]);
  });

  it('shows a monospace command field per check when enabled, and sends the command', async () => {
    allow = true;
    const onRun = await render();
    const cmd = container.querySelector<HTMLInputElement>('input[aria-label="Verify command"]');
    if (!cmd) throw new Error('no verify command input');
    expect(cmd.placeholder).toBe('python3 /path/to/check.py');
    expect(cmd.style.fontFamily).toContain('Geist Mono');
    expect(container.textContent).toContain('exits 0');

    const desc = container.querySelector<HTMLInputElement>('input[placeholder="Description"]');
    if (!desc) throw new Error('no description input');
    await act(async () => setInput(desc, 'tests pass'));
    await act(async () => setInput(cmd, '  pnpm test  '));
    const run = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Run goal');
    await act(async () => run?.click());
    expect(onRun.mock.calls[0]?.[0].checks).toEqual([
      { description: 'tests pass', command: 'pnpm test' },
    ]);
  });

  // Goal g_1806c60c3fb94964 was stored with `checks: []` although its row had a
  // verify command: the submit filter keeps only rows with a description, so a
  // command-only row was dropped, command and all, without a word.
  it('refuses to run with a command-only check and marks the row, instead of dropping it', async () => {
    allow = true;
    const onRun = await render();
    const cmd = container.querySelector<HTMLInputElement>('input[aria-label="Verify command"]');
    const desc = container.querySelector<HTMLInputElement>('input[placeholder="Description"]');
    if (!cmd || !desc) throw new Error('no check inputs');
    await act(async () => setInput(cmd, 'python3 /tmp/check.py'));
    const run = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Run goal');

    await act(async () => run?.click());
    expect(onRun).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('description');
    expect(desc.getAttribute('aria-invalid')).toBe('true');

    await act(async () => setInput(desc, 'every symbol is registered'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => run?.click());
    expect(onRun.mock.calls[0]?.[0].checks).toEqual([
      { description: 'every symbol is registered', command: 'python3 /tmp/check.py' },
    ]);
  });

  it('keeps every described check across rows, with and without a command', async () => {
    allow = true;
    const onRun = await render();
    const add = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Add criterion'),
    );
    await act(async () => add?.click());
    const descs = container.querySelectorAll<HTMLInputElement>('input[placeholder="Description"]');
    const cmds = container.querySelectorAll<HTMLInputElement>('input[aria-label="Verify command"]');
    const [d0, d1] = [descs[0], descs[1]];
    if (!d0 || !d1 || !cmds[0]) throw new Error('expected two check rows');
    await act(async () => setInput(d0, 'progress file complete'));
    await act(async () => setInput(cmds[0] as HTMLInputElement, 'test -s /tmp/progress.csv'));
    await act(async () => setInput(d1, 'dropped symbols have reasons'));
    const run = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Run goal');
    await act(async () => run?.click());
    expect(onRun.mock.calls[0]?.[0].checks).toEqual([
      { description: 'progress file complete', command: 'test -s /tmp/progress.csv' },
      { description: 'dropped symbols have reasons' },
    ]);
  });

  it('still skips a check row left entirely blank', async () => {
    allow = true;
    const onRun = await render();
    const run = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Run goal');
    await act(async () => run?.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(onRun.mock.calls[0]?.[0].checks).toEqual([]);
  });
});
