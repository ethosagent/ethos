// Pure decision: should the bot respond to this inbound?
//
// The matrix:
//   DM                                   -> true
//   channelMode === 'all'                -> true
//   isGroupMention (bot @mentioned)      -> true
//   channelMode === 'thread_follow' AND
//     threadState.hasBotPosted(thread)?  -> true
//   channelMode === 'regex_match' AND
//     pattern matches messageText?       -> true
//   otherwise                            -> false

import type { ChannelMode } from '../config';

export interface ChannelModeInputs {
  isDm: boolean;
  isGroupMention: boolean;
  channelMode: ChannelMode;
  hasBotPosted: boolean;
  /** Message text, used for regex_match mode. */
  messageText?: string;
  /** Regex pattern from the channel override, used for regex_match mode. */
  regexPattern?: string;
}

export function shouldRespond(inputs: ChannelModeInputs): boolean {
  if (inputs.isDm) return true;
  if (inputs.channelMode === 'all') return true;
  if (inputs.isGroupMention) return true;
  if (inputs.channelMode === 'thread_follow' && inputs.hasBotPosted) return true;
  if (inputs.channelMode === 'regex_match') {
    const pattern = inputs.regexPattern;
    if (!pattern) return false;
    try {
      return new RegExp(pattern).test(inputs.messageText ?? '');
    } catch {
      return false; // invalid regex stored — treat as no match
    }
  }
  return false;
}
