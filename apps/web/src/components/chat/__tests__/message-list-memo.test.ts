// @vitest-environment jsdom
//
// A streamed token must not re-render the history. With thousands of rows
// loaded, every `text_delta` used to re-render every bubble, because the list
// handed each one a fresh closure. History bubbles are memoized and their props
// are kept stable, so a `currentTurn` update re-renders only the live bubble.
//
// Render counts are observed through two children the bubbles always render:
// `Trail` (once per AssistantBubble render, keyed by turn id) and
// `formatBytes` (once per UserBubble attachment chip render).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantTurn, ChatMessage } from '../../../lib/chat-reducer';
import { emptyClarifyQueue } from '../../../lib/clarify-queue';
import { emptyRunsState } from '../../../lib/pi-run-reducer';
import type { TrailState } from '../../../lib/trail';
import type { RunSurface } from '../RunCard';

const trailRenders: string[] = [];
const formatBytesCalls = vi.fn();

vi.mock('../Trail', () => ({
  Trail: ({ turnId }: { turnId: string }) => {
    trailRenders.push(turnId);
    return null;
  },
  RowState: () => null,
}));

vi.mock('../../../lib/attachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/attachments')>();
  return {
    ...actual,
    formatBytes: (n: number) => {
      formatBytesCalls();
      return actual.formatBytes(n);
    },
  };
});

// The save modal routes (useNavigate); it is closed and not under test here.
vi.mock('../../dashboard/SaveToDashboardModal', () => ({
  SaveToDashboardModal: () => null,
}));

vi.mock('../../../features/renderers/resolver', () => {
  const resolver = () => null;
  return { useFenceResolver: () => resolver };
});

vi.mock('../../../rpc', () => ({
  rpc: { meta: { capabilities: () => Promise.resolve({ capabilities: { voice_tts: false } }) } },
}));

const { MessageList } = await import('../MessageList');

const history: ChatMessage[] = [
  {
    id: 'u1',
    role: 'user',
    content: 'first',
    timestamp: 1,
    attachments: [
      {
        localId: 'f1',
        state: 'ready',
        type: 'file',
        name: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: 12,
      },
    ],
  },
  { id: 'a1', role: 'assistant', blocks: [{ kind: 'text', content: 'one' }], timestamp: 2 },
  { id: 'u2', role: 'user', content: 'second', timestamp: 3 },
  { id: 'a2', role: 'assistant', blocks: [{ kind: 'text', content: 'two' }], timestamp: 4 },
];

function liveTurn(text: string): AssistantTurn {
  return { id: 'live', role: 'assistant', blocks: [{ kind: 'text', content: text }], timestamp: 5 };
}

const runSurface: RunSurface = {
  runs: emptyRunsState,
  clarifyQueue: emptyClarifyQueue,
  onAnswered: () => undefined,
};
const onSuggestPrompt = () => undefined;
const historyTrail: TrailState = {
  a1: [{ kind: 'action', toolCallId: 't1', toolName: 'read_file', args: {}, status: 'ok' }],
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function render(currentTurn: AssistantTurn, trail: TrailState) {
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MessageList, {
          messages: history,
          currentTurn,
          personalityId: 'test',
          onSuggestPrompt,
          runSurface,
          trail,
          stoppedTurnIds: [],
        }),
      ),
    );
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  trailRenders.length = 0;
  formatBytesCalls.mockReset();
  client = new QueryClient();
  // Seeded, so the bubbles' capabilities query never lands mid-test and gets
  // counted as a render the streaming update caused.
  client.setQueryData(['meta', 'capabilities'], { capabilities: { voice_tts: false } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('MessageList — streaming does not re-render history', () => {
  it('re-renders only the live bubble when currentTurn and its trail update', async () => {
    await render(liveTurn('he'), historyTrail);
    const count = (id: string) => trailRenders.filter((t) => t === id).length;
    const before = { a1: count('a1'), a2: count('a2'), live: count('live') };
    const userChipsBefore = formatBytesCalls.mock.calls.length;
    expect(before.a1).toBeGreaterThan(0);
    expect(userChipsBefore).toBeGreaterThan(0);

    // A text_delta: a new currentTurn object. A tool_start on the live turn: a
    // new trail object whose history entries keep their identity.
    await render(liveTurn('hello'), {
      ...historyTrail,
      live: [
        { kind: 'action', toolCallId: 't2', toolName: 'web_search', args: {}, status: 'running' },
      ],
    });

    expect(count('a1')).toBe(before.a1);
    expect(count('a2')).toBe(before.a2);
    expect(count('live')).toBe(before.live + 1);
    expect(formatBytesCalls.mock.calls.length).toBe(userChipsBefore);
  });
});
