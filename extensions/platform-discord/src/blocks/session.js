import { embed, field } from './shared';
export function sessionEmbed(input) {
    const fields = [
        field('Session', `\`${input.sessionKey}\``, true),
        field('Turns', String(input.turnCount), true),
    ];
    if (input.startedAt)
        fields.push(field('Started', input.startedAt, true));
    if (input.personality)
        fields.push(field('Personality', input.personality, true));
    return embed({ title: 'Session Info', description: '', fields });
}
