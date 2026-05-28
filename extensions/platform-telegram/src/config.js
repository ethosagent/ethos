import { z } from 'zod';
export const ChannelModeSchema = z.enum(['mention_only', 'thread_follow', 'all', 'regex_match']);
export const DEFAULT_CHANNEL_MODE = 'mention_only';
