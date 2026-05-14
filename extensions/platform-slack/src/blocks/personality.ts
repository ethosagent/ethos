import type { Binding } from '../config';
import { context, header, type SlackBlock, section } from './shared';

export function personalityBlocks(binding: Binding): SlackBlock[] {
  const subject = binding.type === 'team' ? 'team coordinator' : 'personality';
  return [
    header('Bot binding'),
    section(`This bot is bound to the *${subject}* \`${binding.name}\`.`),
    context([
      binding.type === 'team'
        ? 'Talking to this bot routes through the team coordinator. Member subprocesses run in the background.'
        : 'Personality switching via `/personality` is disabled for identity-bound bots.',
    ]),
  ];
}
