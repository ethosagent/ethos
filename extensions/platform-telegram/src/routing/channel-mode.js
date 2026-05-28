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
export function shouldRespond(inputs) {
    if (inputs.isDm)
        return true;
    if (inputs.channelMode === 'all')
        return true;
    if (inputs.isGroupMention)
        return true;
    if (inputs.channelMode === 'thread_follow' && inputs.hasBotPosted)
        return true;
    if (inputs.channelMode === 'regex_match') {
        const pattern = inputs.regexPattern;
        if (!pattern)
            return false;
        try {
            return new RegExp(pattern).test(inputs.messageText ?? '');
        }
        catch {
            return false; // invalid regex stored — treat as no match
        }
    }
    return false;
}
