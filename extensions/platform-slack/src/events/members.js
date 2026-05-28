// Posts a one-line greeting when the bot itself is added to a channel.
// We need the bot's own user id to distinguish "the bot joined" from
// "someone else joined" — Slack provides it via `auth.test`, which the
// adapter calls during `start()` and stashes for this handler.
export function registerMemberEvents(app, deps) {
    app.event('member_joined_channel', async ({ event, client }) => {
        if (!deps.selfUserId)
            return;
        if (event.user !== deps.selfUserId)
            return;
        const mode = deps.resolveChannelMode(event.channel);
        const subject = deps.binding.type === 'team' ? 'team coordinator' : 'personality';
        const text = `:wave: I'm bound to the *${subject}* \`${deps.binding.name}\`. ` +
            `This channel is in \`${mode}\` mode. ` +
            `Run \`/ethos channel-mode\` to change it.`;
        try {
            await client.chat.postMessage({ channel: event.channel, text, mrkdwn: true });
        }
        catch {
            // Slack may reject the post if the bot lacks chat:write in this
            // workspace context; surface no error to the operator.
        }
    });
}
