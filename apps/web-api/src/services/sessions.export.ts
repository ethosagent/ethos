import type { StoredMessage as WireStoredMessage } from '@ethosagent/web-contracts';

export function formatAsMarkdown(
  session: { title: string | null; personalityId: string | null; createdAt: string },
  messages: WireStoredMessage[],
): string {
  const title = session.title || 'Untitled session';
  const personality = session.personalityId || 'Assistant';
  const date = session.createdAt.split('T')[0];
  const userAndAssistantMessages = messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant',
  );
  const count = userAndAssistantMessages.length;

  const lines: string[] = [
    `# ${title}`,
    `_${personality} · ${date} · ${count} messages_`,
    '',
    '---',
    '',
  ];

  for (const msg of messages) {
    if (msg.role === 'user') {
      lines.push('**You**');
      lines.push(msg.content);
      lines.push('');
    } else if (msg.role === 'assistant') {
      lines.push(`**${personality}**`);
      lines.push(msg.content);
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const toolNames = msg.toolCalls.map((tc) => tc.name).join(', ');
        lines.push('');
        lines.push(`_Used tools: ${toolNames}_`);
      }
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export function exportFilename(title: string | null, createdAt: string): string {
  const slug = title ? slugify(title) : 'untitled';
  const date = createdAt.split('T')[0];
  return `ethos-${slug}-${date}.md`;
}
