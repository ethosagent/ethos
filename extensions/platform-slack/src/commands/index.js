// Pure slash-command dispatcher. The Bolt adapter calls `dispatch()` with
// the parsed slash command payload; this module decides which subcommand
// runs and returns a structured response. Decoupling Bolt from the
// dispatch logic lets us unit-test subcommands without standing up a real
// Slack app.
import { section } from '../blocks/shared';
import { handleAsk } from './ask';
import { handleChannelMode } from './channel-mode';
import { handleHelp } from './help';
import { handleKanban } from './kanban';
import { handleMemory } from './memory';
import { handlePersonality } from './personality';

const SUBCOMMANDS = ['ask', 'personality', 'memory', 'kanban', 'channel-mode', 'help'];
export function parseSubcommand(text) {
  const trimmed = text.trim();
  if (!trimmed) return { name: 'help', rest: '' };
  const [first, ...restParts] = trimmed.split(/\s+/);
  const candidate = first.toLowerCase();
  const known = SUBCOMMANDS.find((s) => s === candidate);
  if (!known) return { name: 'unknown', rest: trimmed };
  return { name: known, rest: restParts.join(' ') };
}
/** Check whether the invoking user is authorized. When `allowedUsers` is
 *  configured (non-empty), only listed user IDs may proceed. */
function isUserAuthorized(userId, allowedUsers) {
  if (!allowedUsers || allowedUsers.length === 0) return true;
  return allowedUsers.includes(userId);
}
export async function dispatch(payload, ctx) {
  if (!isUserAuthorized(payload.user_id, ctx.allowedUsers)) {
    const blocks = [section('You are not authorized to use this command.')];
    return {
      blocks,
      text: 'You are not authorized to use this command.',
      responseType: 'ephemeral',
    };
  }
  const { name, rest } = parseSubcommand(payload.text);
  switch (name) {
    case 'ask':
      return handleAsk(payload, rest, ctx);
    case 'personality':
      return handlePersonality(rest, ctx);
    case 'memory':
      return handleMemory(rest, ctx);
    case 'kanban':
      return handleKanban(ctx);
    case 'channel-mode':
      return handleChannelMode(payload.channel_id, rest, ctx);
    case 'help':
      return handleHelp(payload.channel_id, ctx);
    case 'unknown': {
      const { unknownSubcommandResponse } = await import('./help');
      return unknownSubcommandResponse(rest, ctx, payload.channel_id);
    }
  }
}
