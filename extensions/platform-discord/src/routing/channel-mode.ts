import type { ChannelMode } from '../config';

export interface ChannelModeInputs {
  isDm: boolean;
  isGroupMention: boolean;
  channelMode: ChannelMode;
  hasBotPosted: boolean;
}

export function shouldRespond(inputs: ChannelModeInputs): boolean {
  if (inputs.isDm) return true;
  if (inputs.channelMode === 'all') return true;
  if (inputs.isGroupMention) return true;
  if (inputs.channelMode === 'thread_follow' && inputs.hasBotPosted) return true;
  return false;
}
