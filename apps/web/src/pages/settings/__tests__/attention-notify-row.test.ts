import { Form } from 'antd';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPane } from '../panes/chat';

// Task 5 (ux-2-attention-signals): the opt-in browser-notification row.
// `renderToStaticMarkup`: apps/web settings tests have no jsdom, so
// `Notification` is undefined unless stubbed and `localStorage` throws
// ReferenceError (the row must treat both as a fallback, not crash).

function chatMarkup(): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(Form, { component: false as const }, createElement(ChatPane)),
    ),
  );
}

/** The row's slice of the markup, from its label to the next row label. */
function rowBlock(html: string): string {
  const start = html.indexOf('Browser notifications');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('settings-row-label', start);
  return html.slice(start, end === -1 ? html.length : end);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Browser notifications row', () => {
  it('explains and disables the switch when Notification is unsupported', () => {
    vi.stubGlobal('Notification', undefined);
    const block = rowBlock(chatMarkup());
    expect(block).toContain('This browser does not support notifications.');
    expect(block).toContain('disabled');
    expect(block).toContain('saves on its own');
  });

  it('shows the blocked copy when permission is denied', () => {
    vi.stubGlobal('Notification', { permission: 'denied' });
    const block = rowBlock(chatMarkup());
    expect(block).toContain('Blocked in your browser&#x27;s site settings');
  });

  it('shows the default help when permission can still be asked', () => {
    vi.stubGlobal('Notification', { permission: 'default' });
    const block = rowBlock(chatMarkup());
    expect(block).toContain('Stored in this browser only.');
    expect(block).not.toContain('ant-switch-disabled');
  });
});
