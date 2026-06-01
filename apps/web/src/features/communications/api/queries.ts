import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { platformKeys } from './keys';

export function usePlatformsList() {
  return useQuery({
    queryKey: platformKeys.list(),
    queryFn: () => rpc.platforms.list(),
  });
}

export function useTelegramBots() {
  return useQuery({
    queryKey: platformKeys.bots('telegram'),
    queryFn: () => rpc.platforms.botsListTelegram(),
  });
}

export function useSlackBots() {
  return useQuery({
    queryKey: platformKeys.bots('slack'),
    queryFn: () => rpc.platforms.botsListSlack(),
  });
}

export function useWhatsAppBots() {
  return useQuery({
    queryKey: platformKeys.bots('whatsapp'),
    queryFn: () => rpc.platforms.botsListWhatsApp(),
  });
}

export function useChannelFilter(platform: string) {
  return useQuery({
    queryKey: platformKeys.channelFilter(platform),
    queryFn: () => rpc.platforms.getChannelFilter({ platform }),
  });
}
