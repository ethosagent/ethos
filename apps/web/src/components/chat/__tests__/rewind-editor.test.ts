// @vitest-environment jsdom
//
// The inline "Edit & rerun" editor: prefilled textarea, the fixed side-effect
// notice, Rerun / Cancel, Cmd/Ctrl+Enter and Esc, and a refusal that keeps the
// editor open with the error.

import { REWIND_BUSY, REWIND_NOTICE } from '@ethosagent/surface-kit';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RewindEditor } from '../RewindEditor';

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

function mount(props: {
  initialText?: string;
  hadAttachments?: boolean;
  onRerun?: (t: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const onRerun = props.onRerun ?? vi.fn(() => Promise.resolve());
  const onCancel = props.onCancel ?? vi.fn();
  act(() => {
    root.render(
      createElement(RewindEditor, {
        initialText: props.initialText ?? 'b',
        hadAttachments: props.hadAttachments ?? false,
        onRerun,
        onCancel,
      }),
    );
  });
  return { onRerun, onCancel };
}

function textarea(): HTMLTextAreaElement {
  const el = container.querySelector('textarea');
  if (!el) throw new Error('no textarea');
  return el;
}

function button(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.startsWith(label),
  );
  if (!el) throw new Error(`no button ${label}`);
  return el;
}

function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('RewindEditor', () => {
  it('reruns the edited text and shows the side-effect notice', async () => {
    const { onRerun } = mount({ initialText: 'b' });
    expect(textarea().value).toBe('b');
    expect(container.textContent).toContain(REWIND_NOTICE);
    typeInto(textarea(), 'b2');
    await act(async () => {
      button('Rerun').click();
    });
    expect(onRerun).toHaveBeenCalledWith('b2');
  });

  it('Cmd/Ctrl+Enter reruns', async () => {
    const { onRerun } = mount({ initialText: 'go' });
    await act(async () => {
      textarea().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
      );
    });
    expect(onRerun).toHaveBeenCalledWith('go');
  });

  it('Esc cancels and an empty text disables Rerun', () => {
    const { onCancel } = mount({ initialText: 'x' });
    typeInto(textarea(), '   ');
    expect(button('Rerun').disabled).toBe(true);
    act(() => {
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Cancel button cancels', () => {
    const { onCancel } = mount({});
    act(() => button('Cancel').click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('a refused rerun keeps the editor open with the error and the text', async () => {
    const onRerun = vi.fn(() => Promise.reject(new Error(REWIND_BUSY)));
    mount({ initialText: 'keep me', onRerun });
    await act(async () => {
      button('Rerun').click();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(REWIND_BUSY);
    expect(textarea().value).toBe('keep me');
    expect(button('Rerun').disabled).toBe(false);
  });

  it('shows Rerunning… while pending', async () => {
    let resolve: () => void = () => {};
    const onRerun = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    mount({ onRerun });
    await act(async () => {
      button('Rerun').click();
    });
    expect(container.textContent).toContain('Rerunning…');
    await act(async () => resolve());
  });

  it('says attached files are not re-sent when the prompt had attachments', () => {
    mount({ hadAttachments: true });
    expect(container.textContent).toContain('not re-sent');
  });
});
