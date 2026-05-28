import { embed } from './shared';
export function helpEmbed(input) {
  const { binding, channelMode } = input;
  return embed({
    title: 'Ethos · Slash Commands',
    description: [
      `**Bound to** ${binding.type} \`${binding.name}\``,
      `**Channel mode**: \`${channelMode}\``,
      '',
      '`/ethos ask <prompt>` — submit a prompt to the bound agent',
      '`/ethos help` — this message',
      '`/ethos new` — clear current session',
      '`/ethos personality list|switch` — personality control',
      '`/ethos memory show|clear` — memory control',
      '`/ethos status` — recent sessions + waiting clarifies',
      '`/ethos kanban` — kanban summary',
      '',
      '**Modes:** `mention_only` (default) responds to DMs and @mentions; ' +
        '`thread_follow` also responds in threads the bot has posted in; ' +
        '`all` responds to every message.',
    ].join('\n'),
  });
}
