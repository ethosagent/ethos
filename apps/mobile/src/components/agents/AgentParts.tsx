import { personalityAccent } from '@ethosagent/design-tokens';
import { Stack, useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { modelName, usePersonalities, useTeams } from '../../api/queries';
import type { KvGroup } from '../../features/agents/character-sheet';
import { teamLine } from '../../features/agents/grouping';
import { tabBarBottomInset } from '../../lib/tab-bar-inset';
import { color, radius, TAB_BAR_PILL_HEIGHT, type } from '../../theme/tokens';
import { Mark } from '../ui/Mark';

/** Bottom clearance for a scrolling list under the floating tab bar. */
export function useListBottomInset(): number {
  const insets = useSafeAreaInsets();
  return tabBarBottomInset({
    tabBarHeight: TAB_BAR_PILL_HEIGHT,
    safeAreaBottom: insets.bottom,
    keyboardVisible: false,
  });
}

/** `ListItem` with a lead mark (§10: min 60, separator inset past the mark). */
export function AgentRow(props: {
  personalityId: string;
  title: string;
  subtitle: string | null;
  mono?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[props.title, props.subtitle].filter(Boolean).join(', ')}
      onPress={props.onPress}
      style={({ pressed }) => [styles.item, pressed ? styles.pressed : null]}
    >
      <Mark personalityId={props.personalityId} size={36} />
      <View style={styles.itemText}>
        <Text style={type.body} numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text style={props.mono ? type.mono : type.small} numberOfLines={2}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <Text accessibilityRole="header" style={[type.small, styles.header]}>
      {children}
    </Text>
  );
}

/** `Chip` (§10): 28 drawn, 44 touch via hitSlop. */
export function Chip(props: { label: string; selected?: boolean; onPress?: () => void }) {
  return (
    <Pressable
      accessibilityRole={props.onPress ? 'button' : 'text'}
      accessibilityState={{ selected: !!props.selected }}
      disabled={!props.onPress}
      onPress={props.onPress}
      hitSlop={8}
      style={({ pressed }) => [
        styles.chip,
        props.selected ? styles.chipOn : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Text style={[type.small, props.selected ? { color: color.textPrimary } : null]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

/** `Segmented` (§10): a tablist, no animation between segments. */
export function Segmented<K extends string>(props: {
  segments: ReadonlyArray<{ key: K; label: string }>;
  value: K;
  onChange: (key: K) => void;
}) {
  return (
    <View accessibilityRole="tablist" style={styles.track}>
      {props.segments.map((s) => {
        const selected = s.key === props.value;
        return (
          <Pressable
            key={s.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => props.onChange(s.key)}
            hitSlop={{ top: 6, bottom: 6 }}
            style={[styles.segment, selected ? styles.segmentOn : null]}
          >
            <Text style={[styles.segmentLabel, selected ? { color: color.textPrimary } : null]}>
              {s.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export type AgentSegment = 'sheet' | 'memory' | 'schedule' | 'skills';
const SEGMENTS: ReadonlyArray<{ key: AgentSegment; label: string }> = [
  { key: 'sheet', label: 'Sheet' },
  { key: 'memory', label: 'Memory' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'skills', label: 'Skills' },
];
const SEGMENT_PATH: Record<AgentSegment, string> = {
  sheet: '/agents/[id]',
  memory: '/agents/[id]/memory',
  schedule: '/agents/[id]/schedule',
  skills: '/agents/[id]/skills',
};

/**
 * The agent's hero — 56 px mark, name, model in mono, team role — which takes
 * the personality's accent (the mark and the role line; the nav bar does not, D4),
 * then the description and the Sheet · Memory · Schedule · Skills control.
 * One route per segment; switching replaces, so Back always returns to Agents.
 */
export function AgentHeader(props: {
  personalityId: string;
  name: string;
  model: string | null;
  teamLine: string | null;
  description: string | null;
  segment: AgentSegment;
}) {
  const router = useRouter();
  const accent = personalityAccent(props.personalityId);
  return (
    <View>
      <View style={styles.hero}>
        <Mark personalityId={props.personalityId} size={56} />
        <View style={styles.itemText}>
          <Text style={type.h4}>{props.name}</Text>
          {props.model ? <Text style={type.mono}>{props.model}</Text> : null}
          {props.teamLine ? (
            <Text style={[type.mono, { color: accent }]}>{props.teamLine}</Text>
          ) : null}
        </View>
      </View>
      {props.description ? (
        <Text style={[type.body, styles.description]}>{props.description}</Text>
      ) : null}
      <View style={styles.segmentWrap}>
        <Segmented
          segments={SEGMENTS}
          value={props.segment}
          onChange={(key) => {
            if (key === props.segment) return;
            router.replace({ pathname: SEGMENT_PATH[key], params: { id: props.personalityId } });
          }}
        />
      </View>
    </View>
  );
}

/**
 * Every agent segment's top: the nav bar (back `Agents`, title = name, right
 * `Chat` — a new chat with this personality, as New session starts one) and
 * the hero, rendered at once from the list data already in the cache (§11a).
 */
export function AgentScreenHeader({ id, segment }: { id: string; segment: AgentSegment }) {
  const router = useRouter();
  const agents = usePersonalities();
  const teams = useTeams();
  const p = agents.data?.items.find((x) => x.id === id);
  return (
    <>
      <Stack.Screen
        options={{
          title: p?.name ?? id,
          headerBackTitle: 'Agents',
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Chat with ${p?.name ?? id}`}
              onPress={() =>
                router.navigate({
                  pathname: '/chat/[sessionId]',
                  params: { sessionId: 'new', personalityId: id },
                })
              }
              style={styles.headerButton}
            >
              <Text style={[type.body, { color: color.chrome }]}>Chat</Text>
            </Pressable>
          ),
        }}
      />
      <AgentHeader
        personalityId={id}
        name={p?.name ?? id}
        model={modelName(p?.model)}
        teamLine={teams.data ? teamLine(id, teams.data.items) : null}
        description={p?.description ?? null}
        segment={segment}
      />
    </>
  );
}

/** `KV` (§10): 112 key column; a group with no rows says `None.`; the toolset
 *  is a chip row that wraps (nothing horizontal that cannot wrap, §6a). */
export function KvGroups({ groups }: { groups: readonly KvGroup[] }) {
  return (
    <View>
      {groups.map((g) => (
        <View key={g.title} style={styles.group}>
          <SectionHeader>{g.title}</SectionHeader>
          {g.rows.length === 0 ? (
            <Text style={[type.small, styles.kvRow]}>None.</Text>
          ) : g.kind === 'chips' ? (
            <View style={styles.chipWrap}>
              {g.rows.map((r) => (
                <Chip key={r.value} label={r.value} />
              ))}
            </View>
          ) : (
            g.rows.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a sheet's rows are static per render
              <View key={i} style={styles.kvRow} accessible>
                {r.key ? <Text style={[type.small, styles.kvKey]}>{r.key}</Text> : null}
                <View style={styles.itemText}>
                  <Text style={type.body}>{r.value}</Text>
                  {r.detail.map((d) => (
                    <Text key={d} style={type.mono}>
                      {d}
                    </Text>
                  ))}
                </View>
              </View>
            ))
          )}
        </View>
      ))}
    </View>
  );
}

/** A horizontally scrolling chip row (§6a: chip rows scroll, nothing else does). */
export function ChipRow({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chipRow}
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  item: {
    minHeight: 60,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  itemText: { flex: 1, gap: 2 },
  headerButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  pressed: { backgroundColor: color.bgOverlay },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6, textTransform: 'uppercase' },
  chip: {
    minHeight: 28,
    paddingHorizontal: 11,
    paddingVertical: 5,
    justifyContent: 'center',
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: color.borderSubtle,
    backgroundColor: color.bgElevated,
  },
  chipOn: { backgroundColor: color.bgOverlay, borderColor: color.borderStrong },
  chipRow: { paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16 },
  track: {
    flexDirection: 'row',
    minHeight: 32,
    padding: 2,
    borderRadius: radius.md,
    backgroundColor: color.bgOverlay,
  },
  segment: {
    flex: 1,
    minHeight: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  segmentOn: { backgroundColor: color.bgElevated },
  segmentLabel: { ...type.small, fontWeight: '500' },
  segmentWrap: { paddingHorizontal: 16, paddingVertical: 8 },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  description: { paddingHorizontal: 16, paddingTop: 10 },
  group: { borderBottomWidth: 1, borderBottomColor: color.borderSubtle, paddingBottom: 8 },
  kvRow: {
    minHeight: 36,
    paddingHorizontal: 16,
    paddingVertical: 6,
    flexDirection: 'row',
    gap: 8,
  },
  kvKey: { width: 112, flexShrink: 0 },
});
