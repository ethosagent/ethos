// Pure decision: should the bot respond to this inbound?
//
// The matrix:
//   DM                                   → true
//   channelMode === 'all'                → true
//   isGroupMention (bot @mentioned)      → true
//   channelMode === 'thread_follow' AND
//     threadState.hasBotPosted(thread)?  → true
//   otherwise                            → false
export function shouldRespond(inputs) {
    if (inputs.isDm)
        return true;
    if (inputs.channelMode === 'all')
        return true;
    if (inputs.isGroupMention)
        return true;
    if (inputs.channelMode === 'thread_follow' && inputs.hasBotPosted)
        return true;
    return false;
}
