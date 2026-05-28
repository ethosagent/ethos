import { embed, field } from '../blocks/shared';
export function handleStatus(_payload, _ctx) {
    return {
        embeds: [
            embed({
                title: 'Ethos Status',
                description: 'Current agent status overview.',
                fields: [
                    field('Sessions', 'No active sessions', true),
                    field('Waiting Clarifies', 'None', true),
                ],
            }),
        ],
        ephemeral: true,
    };
}
