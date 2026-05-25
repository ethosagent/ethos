import { z } from 'zod';

export const ChannelModeSchema = z.enum(['mention_only', 'thread_follow', 'all', 'regex_match']);
export type ChannelMode = z.infer<typeof ChannelModeSchema>;

export const DEFAULT_CHANNEL_MODE: ChannelMode = 'mention_only';
