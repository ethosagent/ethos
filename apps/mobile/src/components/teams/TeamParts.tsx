import { personalityAccent } from '@ethosagent/design-tokens';
import type { KanbanTask, KanbanTaskSummary } from '@ethosagent/web-contracts';
import { Stack, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { tileIdLine, tileStatusRow } from '../../features/teams/teams-list';
import { color, radius, type } from '../../theme/tokens';
import { Segmented } from '../agents/AgentParts';
import { Mark } from '../ui/Mark';
import { Row } from '../ui/Row';

/** `TeamRing` (§10): one arc per member in its accent, track `--border`.
 *  An empty team (or the Teams empty state) is the hollow outline. */
export function TeamRing({
  team,
  members,
  size = 40,
}: {
  team: string;
  members: readonly string[];
  size?: number;
}) {
  const stroke = 3.6;
  const r = (size - stroke) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  const n = members.length;
  const gap = n > 1 ? Math.min(4, circ / n / 4) : 0;
  const seg = n > 0 ? circ / n : 0;
  return (
    <Svg
      width={size}
      height={size}
      accessibilityRole="image"
      accessibilityLabel={`${team}, ${n} ${n === 1 ? 'member' : 'members'}`}
    >
      <Circle
        cx={c}
        cy={c}
        r={r}
        stroke={n === 0 ? color.borderStrong : color.borderSubtle}
        strokeWidth={stroke}
        fill="none"
      />
      {members.map((id, i) => (
        <Circle
          key={id}
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={personalityAccent(id)}
          strokeWidth={stroke}
          strokeDasharray={`${Math.max(0, seg - gap)} ${circ}`}
          strokeDashoffset={-i * seg}
          transform={`rotate(-90 ${c} ${c})`}
        />
      ))}
    </Svg>
  );
}

export type DotState = 'running' | 'blocked' | 'idle' | 'offline' | 'live' | 'warn' | 'dim';

const DOT: Record<DotState, { fill: string; ring: boolean; word: string }> = {
  running: { fill: color.success, ring: true, word: 'running' },
  live: { fill: color.success, ring: true, word: 'live' },
  blocked: { fill: color.warning, ring: false, word: 'blocked' },
  warn: { fill: color.warning, ring: false, word: 'stale' },
  idle: { fill: color.textSecondary, ring: false, word: 'idle' },
  offline: { fill: color.textTertiary, ring: false, word: 'offline' },
  dim: { fill: color.textTertiary, ring: false, word: 'stopped' },
};

/** `StatusDot` (§10): 8 px; live carries the one sanctioned 3 px glow. Always
 *  beside a visible word — never colour alone (D7). Static: no pulse yet. */
export function StatusDot({ state }: { state: DotState }) {
  const d = DOT[state];
  return (
    <View
      accessible
      accessibilityLabel={d.word}
      style={[
        styles.dot,
        { backgroundColor: d.fill },
        d.ring ? { borderWidth: 3, borderColor: `${d.fill}66`, width: 14, height: 14 } : null,
      ]}
    />
  );
}

/** The task `Tile` (Card exemption 3): id · priority, title, the reason as a
 *  feedback row inside, assignee mark and meta. No stripe (amendment 16). */
export function TaskTile({
  task,
  reason,
  meta,
  team,
  onPress,
}: {
  task: KanbanTaskSummary | KanbanTask;
  reason?: string;
  meta?: string;
  /** Shown in the id line when tiles from several teams mix. */
  team?: string;
  onPress: () => void;
}) {
  const row = tileStatusRow(task, reason);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${task.title}, ${task.status.replace('_', ' ')}`}
      onPress={onPress}
      style={({ pressed }) => [styles.tile, pressed ? styles.pressed : null]}
    >
      <Text style={type.mono}>{[team, tileIdLine(task)].filter(Boolean).join(' · ')}</Text>
      <Text style={type.body} numberOfLines={2}>
        {task.title}
      </Text>
      {row ? (
        <View style={styles.tileRow}>
          <Row row={row} />
        </View>
      ) : null}
      <View style={styles.tileFoot}>
        {task.assignee ? <Mark personalityId={task.assignee} size={18} /> : null}
        <Text style={[type.mono, styles.flex]} numberOfLines={1}>
          {meta ?? task.assignee ?? 'unassigned'}
        </Text>
        <Text style={[type.small, { color: color.chrome }]}>Open →</Text>
      </View>
    </Pressable>
  );
}

export function SectionTitle({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[type.small, styles.sectionText]}>
        {title}
      </Text>
      {action && onAction ? (
        <Pressable accessibilityRole="button" onPress={onAction} hitSlop={12}>
          <Text style={[type.small, { color: color.chrome }]}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export type TeamSegment = 'overview' | 'board' | 'structure' | 'more';
const SEGMENTS: ReadonlyArray<{ key: TeamSegment; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'board', label: 'Board' },
  { key: 'structure', label: 'Structure' },
  { key: 'more', label: 'More' },
];
const SEGMENT_PATH: Record<TeamSegment, string> = {
  overview: '/teams/[teamId]/overview',
  board: '/teams/[teamId]/board',
  structure: '/teams/[teamId]/structure',
  more: '/teams/[teamId]/more',
};

/**
 * Every team segment's top: the nav bar (title = team, right `Chat` and
 * `Settings`) and the Overview · Board · Structure · More control. One route
 * per segment, switching replaces — the Agents detail's pattern — so Back
 * always returns to Teams.
 */
export function TeamScreenHeader({ team, segment }: { team: string; segment: TeamSegment }) {
  const router = useRouter();
  return (
    <>
      <Stack.Screen
        options={{
          title: team,
          headerBackTitle: 'Teams',
          headerRight: () => (
            <View style={styles.navRight}>
              <NavButton
                label="Chat"
                a11y={`Chat with ${team}'s coordinator`}
                onPress={() =>
                  router.push({ pathname: '/teams/[teamId]/chat', params: { teamId: team } })
                }
              />
              <NavButton
                label="Settings"
                a11y={`${team} settings`}
                onPress={() =>
                  router.push({ pathname: '/teams/[teamId]/settings', params: { teamId: team } })
                }
              />
            </View>
          ),
        }}
      />
      <View style={styles.segmentWrap}>
        <Segmented
          segments={SEGMENTS}
          value={segment}
          onChange={(key) => {
            if (key === segment) return;
            router.replace({ pathname: SEGMENT_PATH[key], params: { teamId: team } });
          }}
        />
      </View>
    </>
  );
}

function NavButton(props: { label: string; a11y: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.a11y}
      onPress={props.onPress}
      style={styles.navButton}
    >
      <Text style={[type.body, { color: color.chrome }]}>{props.label}</Text>
    </Pressable>
  );
}

/** A literal the operator also types — Geist Mono in a bordered line. */
export function CommandLine({ command }: { command: string }) {
  return (
    <Text selectable style={[type.mono, styles.command]}>
      {command}
    </Text>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pressed: { backgroundColor: color.bgOverlay },
  dot: { width: 8, height: 8, borderRadius: 7 },
  tile: {
    minHeight: 72,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginHorizontal: 16,
    marginVertical: 4,
    gap: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.borderSubtle,
    backgroundColor: color.bgElevated,
  },
  tileRow: { marginHorizontal: -16 },
  tileFoot: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 24 },
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 6,
    minHeight: 44,
  },
  sectionText: { textTransform: 'uppercase' },
  segmentWrap: { paddingHorizontal: 16, paddingVertical: 8 },
  navRight: { flexDirection: 'row' },
  navButton: {
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  command: {
    borderWidth: 1,
    borderColor: color.borderSubtle,
    borderRadius: radius.sm,
    padding: 8,
    color: color.textPrimary,
  },
});
