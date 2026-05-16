import { embed, field } from '../blocks/shared';
import type { CommandContext, CommandPayload, CommandResponse } from './index';

export function handleStatus(_payload: CommandPayload, _ctx: CommandContext): CommandResponse {
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
