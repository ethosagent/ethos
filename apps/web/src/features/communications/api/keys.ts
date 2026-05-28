export const platformKeys = {
  all: () => ['platforms'] as const,
  list: () => [...platformKeys.all(), 'list'] as const,
  bots: (platform: string) => [...platformKeys.all(), 'bots', platform] as const,
  channelFilter: (platform: string) => [...platformKeys.all(), 'channelFilter', platform] as const,
};
