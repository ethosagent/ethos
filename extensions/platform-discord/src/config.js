import { z } from 'zod';
export const ChannelModeSchema = z.enum(['mention_only', 'thread_follow', 'all']);
export const DEFAULT_CHANNEL_MODE = 'mention_only';
export const BindingSchema = z.object({
    type: z.enum(['personality', 'team']),
    name: z.string(),
});
