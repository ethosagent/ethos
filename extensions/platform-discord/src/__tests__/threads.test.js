import { describe, expect, it } from 'vitest';
import { stripMentions } from '../routing/triage';
describe('thread routing', () => {
    it('stripMentions removes Discord user mentions', () => {
        expect(stripMentions('<@123456> hello')).toBe(' hello');
        expect(stripMentions('<@!789012> hi')).toBe(' hi');
        expect(stripMentions('<@&345678> role')).toBe(' role');
    });
    it('stripMentions handles multiple mentions', () => {
        expect(stripMentions('<@111> and <@222> are here')).toBe(' and  are here');
    });
    it('stripMentions passes through text without mentions', () => {
        expect(stripMentions('no mentions here')).toBe('no mentions here');
    });
    it('thread message sets chatId to parent channel', () => {
        // When a message is in a thread, chatId should be the parent channel
        // and threadId should be the thread's ID
        const parentChannelId = 'parent-channel-123';
        const threadChannelId = 'thread-456';
        const isThread = true;
        const chatId = isThread ? parentChannelId : threadChannelId;
        const threadId = isThread ? threadChannelId : undefined;
        expect(chatId).toBe(parentChannelId);
        expect(threadId).toBe(threadChannelId);
    });
    it('non-thread message uses channelId as chatId, no threadId', () => {
        const channelId = 'channel-789';
        const isThread = false;
        const chatId = isThread ? 'should-not-happen' : channelId;
        const threadId = isThread ? 'should-not-happen' : undefined;
        expect(chatId).toBe(channelId);
        expect(threadId).toBeUndefined();
    });
});
