// @ethosagent/tools-social-search — social-platform discovery tools.
//
// M1 shipped the YouTube pair: youtube_search and youtube_comments, over the
// free YouTube Data API v3. M3 adds quora_search and linkedin_search,
// search-derived over @ethosagent/tools-web's backends and constrained to
// one site each. See plan/phases/social-search-tools.md.

export type { SiteProfile } from './site/filter';
export { LINKEDIN_PROFILE, QUORA_PROFILE } from './site/filter';
export type { CreateLinkedInSearchToolOptions } from './site/linkedin';
export { createLinkedInSearchTool, linkedInSearchTool } from './site/linkedin';
export type { CreateQuoraSearchToolOptions } from './site/quora';
export { createQuoraSearchTool, quoraSearchTool } from './site/quora';
export type { YouTubeCommentsArgs, YouTubeCommentsOrder } from './youtube/comments';
export { createYouTubeCommentsTool, youtubeCommentsTool } from './youtube/comments';
export type { CreateYouTubeToolOptions, YouTubeToolSetting } from './youtube/constants';
export { parseYouTubeVideoId } from './youtube/ids';
export type { YouTubeSearchArgs, YouTubeSearchOrder } from './youtube/search';
export { createYouTubeSearchTool, youtubeSearchTool } from './youtube/search';
