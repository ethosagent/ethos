import { describe, expect, it } from 'vitest';
import { exportFilename, formatAsMarkdown, slugify } from '../sessions.export';

describe('formatAsMarkdown', () => {
  it('formats a basic conversation', () => {
    const session = {
      title: 'Recipe Help',
      personalityId: 'hermes',
      createdAt: '2025-05-23T10:00:00.000Z',
    };
    const messages = [
      {
        id: '1',
        sessionId: 's1',
        role: 'user' as const,
        content: 'How do I make pasta?',
        toolCallId: null,
        toolName: null,
        toolCalls: null,
        timestamp: '2025-05-23T10:00:01.000Z',
      },
      {
        id: '2',
        sessionId: 's1',
        role: 'assistant' as const,
        content: 'Boil water, add pasta, cook 8 min.',
        toolCallId: null,
        toolName: null,
        toolCalls: null,
        timestamp: '2025-05-23T10:00:02.000Z',
      },
    ];
    const md = formatAsMarkdown(session, messages);
    expect(md).toContain('# Recipe Help');
    expect(md).toContain('hermes');
    expect(md).toContain('**You**');
    expect(md).toContain('How do I make pasta?');
    expect(md).toContain('**hermes**');
    expect(md).toContain('Boil water');
  });

  it('shows tool calls as summary line', () => {
    const session = { title: null, personalityId: null, createdAt: '2025-05-23T10:00:00.000Z' };
    const messages = [
      {
        id: '1',
        sessionId: 's1',
        role: 'user' as const,
        content: 'Read file',
        toolCallId: null,
        toolName: null,
        toolCalls: null,
        timestamp: '2025-05-23T10:00:01.000Z',
      },
      {
        id: '2',
        sessionId: 's1',
        role: 'assistant' as const,
        content: 'Here is the file.',
        toolCallId: null,
        toolName: null,
        toolCalls: [{ id: 'tc1', name: 'read_file', input: {} }],
        timestamp: '2025-05-23T10:00:02.000Z',
      },
    ];
    const md = formatAsMarkdown(session, messages);
    expect(md).toContain('_Used tools: read_file_');
    expect(md).toContain('# Untitled session');
  });

  it('skips tool_result and system messages', () => {
    const session = { title: 'Test', personalityId: null, createdAt: '2025-05-23T10:00:00.000Z' };
    const messages = [
      {
        id: '1',
        sessionId: 's1',
        role: 'system' as const,
        content: 'system prompt',
        toolCallId: null,
        toolName: null,
        toolCalls: null,
        timestamp: '2025-05-23T10:00:00.000Z',
      },
      {
        id: '2',
        sessionId: 's1',
        role: 'user' as const,
        content: 'Hello',
        toolCallId: null,
        toolName: null,
        toolCalls: null,
        timestamp: '2025-05-23T10:00:01.000Z',
      },
      {
        id: '3',
        sessionId: 's1',
        role: 'tool_result' as const,
        content: 'tool output',
        toolCallId: 'tc1',
        toolName: 'read_file',
        toolCalls: null,
        timestamp: '2025-05-23T10:00:02.000Z',
      },
    ];
    const md = formatAsMarkdown(session, messages);
    expect(md).not.toContain('system prompt');
    expect(md).not.toContain('tool output');
    expect(md).toContain('Hello');
  });
});

describe('slugify', () => {
  it('converts to slug', () => {
    expect(slugify('My Great Title')).toBe('my-great-title');
    expect(slugify('Hello World!!!')).toBe('hello-world');
  });
});

describe('exportFilename', () => {
  it('uses title slug', () => {
    expect(exportFilename('Recipe Help', '2025-05-23T10:00:00.000Z')).toBe(
      'ethos-recipe-help-2025-05-23.md',
    );
  });

  it('uses untitled when no title', () => {
    expect(exportFilename(null, '2025-05-23T10:00:00.000Z')).toBe('ethos-untitled-2025-05-23.md');
  });
});
