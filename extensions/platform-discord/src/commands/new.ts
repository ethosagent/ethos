import { embed } from '../blocks/shared';
import type { CommandContext, CommandPayload, CommandResponse } from './index';

export function handleNew(_payload: CommandPayload, _ctx: CommandContext): CommandResponse {
  return {
    embeds: [embed({ title: 'Session Cleared', description: 'Started a fresh session.' })],
    ephemeral: true,
  };
}
