import { useQuery } from '@tanstack/react-query';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useRpc } from '../../src/api/queries';
import { RouteError } from '../../src/components/ui/RouteError';
import { NEEDS_YOU_KEY, needsYouCount } from '../../src/features/activity/needs-you';
import { useChatStore } from '../../src/state/chat-store';
import { color } from '../../src/theme/tokens';

export { RouteError as ErrorBoundary };

/**
 * NativeTabs (R11) — `UITabBarController` on iOS — tinted `--info` at every
 * altitude (D4). Phase 1 has three tabs; Agents and Teams join in Phase 2.
 * The Activity badge is "Needs you": pending approvals across the server
 * plus the open session's questions.
 */
export default function TabsLayout() {
  const rpc = useRpc();
  const approvals = useQuery({
    queryKey: NEEDS_YOU_KEY,
    queryFn: () => rpc.tools.listPending({}),
  });
  const questions = useChatStore((s) => s.chat.pendingClarifies.length);
  const count = needsYouCount(approvals.data ?? [], questions);

  return (
    <NativeTabs tintColor={color.chrome}>
      <NativeTabs.Trigger name="chat">
        <NativeTabs.Trigger.Label>Chat</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="bubble.left.and.bubble.right" md="chat" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="activity">
        <NativeTabs.Trigger.Label>Activity</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="waveform.path.ecg" md="monitoring" />
        {count > 0 ? <NativeTabs.Trigger.Badge>{String(count)}</NativeTabs.Trigger.Badge> : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="more">
        <NativeTabs.Trigger.Label>More</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="ellipsis.circle" md="more_horiz" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
