import { type DiscordEmbed, embed, field } from './shared';

export interface SessionInfoInput {
  sessionKey: string;
  turnCount: number;
  startedAt?: string;
  personality?: string;
}

export function sessionEmbed(input: SessionInfoInput): DiscordEmbed {
  const fields = [
    field('Session', `\`${input.sessionKey}\``, true),
    field('Turns', String(input.turnCount), true),
  ];
  if (input.startedAt) fields.push(field('Started', input.startedAt, true));
  if (input.personality) fields.push(field('Personality', input.personality, true));
  return embed({ title: 'Session Info', description: '', fields });
}
