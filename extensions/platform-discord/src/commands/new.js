import { embed } from '../blocks/shared';
export function handleNew(_payload, _ctx) {
    return {
        embeds: [embed({ title: 'Session Cleared', description: 'Started a fresh session.' })],
        ephemeral: true,
    };
}
