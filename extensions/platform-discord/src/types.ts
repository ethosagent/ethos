import type { ClarifyInteractionEvent } from './clarify-interactions';

export interface DiscordClarifyInteraction {
  event: ClarifyInteractionEvent;
  interactionId: string;
  interactionToken: string;
}
