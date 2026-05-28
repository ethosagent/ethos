export function shouldRespond(inputs) {
  if (inputs.isDm) return true;
  if (inputs.channelMode === 'all') return true;
  if (inputs.isGroupMention) return true;
  if (inputs.channelMode === 'thread_follow' && inputs.hasBotPosted) return true;
  return false;
}
