import { useQuery } from '@tanstack/react-query';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useRpc } from '../../src/api/queries';
import { RouteError } from '../../src/components/ui/RouteError';
import { NEEDS_YOU_KEY, needsYouCount } from '../../src/features/activity/needs-you';
import { useCallMode } from '../../src/state/call-mode';
import { useChatStore } from '../../src/state/chat-store';
import { color } from '../../src/theme/tokens';

export { RouteError as ErrorBoundary };

/**
 * NativeTabs (R11) — `UITabBarController` on iOS — tinted `--info` at every
 * altitude (D4). The order is §2's: Chat · Agents · Teams · Activity · More.
 * Agents (the Library, its icon the annulus) and Teams (the segmented-ring
 * glyph, §12 amendment 6) joined in Phase 2 — five tabs, Android's maximum.
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
  // The Call Stage is a mode: no tab bar while it is focused (§2, T7).
  const stageFocused = useCallMode((s) => s.stageFocused);

  return (
    <NativeTabs tintColor={color.chrome} hidden={stageFocused}>
      <NativeTabs.Trigger name="chat">
        <NativeTabs.Trigger.Label>Chat</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="bubble.left.and.bubble.right" md="chat" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="agents">
        <NativeTabs.Trigger.Label>Agents</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="circle.circle" md="radio_button_unchecked" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="teams">
        <NativeTabs.Trigger.Label>Teams</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="circle.dotted" md="donut_large" />
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
