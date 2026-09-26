import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { errorRow } from '../../../../src/api/errors';
import { useRpc } from '../../../../src/api/queries';
import {
  AgentScreenHeader,
  Chip,
  ChipRow,
  useListBottomInset,
} from '../../../../src/components/agents/AgentParts';
import { MarkdownView } from '../../../../src/components/agents/MarkdownView';
import { RouteError } from '../../../../src/components/ui/RouteError';
import { Row } from '../../../../src/components/ui/Row';
import { Skeleton } from '../../../../src/components/ui/Skeleton';
import { candidateView } from '../../../../src/features/agents/skills';
import { color, radius, type } from '../../../../src/theme/tokens';

export { RouteError as ErrorBoundary };

type Tab = 'installed' | 'proposed';

/**
 * agent-skills (§5): Installed · Proposed. Skill cards are the first Card
 * exemption; a proposal is the same card with a `⚠ proposed` row and a
 * read-only Review that ends in `Review on the web`. Approve, reject and
 * dismiss are cookie-only (D12: a skill changes what an agent can do), and no
 * ClawHub call is bearer-reachable — none of those controls is rendered.
 */
export default function AgentSkills() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const rpc = useRpc();
  const bottomInset = useListBottomInset();
  const [tab, setTab] = useState<Tab>('installed');
  const [open, setOpen] = useState<string | null>(null);
  const skills = useQuery({
    queryKey: ['personalities', 'skills', id],
    queryFn: () => rpc.personalities.skillsList({ personalityId: id }),
  });
  const candidates = useQuery({
    queryKey: ['personalities', 'skillCandidates', id],
    queryFn: () => rpc.personalities.skillCandidatesList({ personalityId: id }),
  });
  const installed = skills.data?.skills ?? [];
  const proposed = candidates.data?.candidates ?? [];
  const active = tab === 'installed' ? skills : candidates;
  const toggle = (key: string) => setOpen((o) => (o === key ? null : key));

  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: bottomInset }}
      refreshControl={
        <RefreshControl
          refreshing={skills.isRefetching || candidates.isRefetching}
          onRefresh={() => {
            void skills.refetch();
            void candidates.refetch();
          }}
        />
      }
    >
      <AgentScreenHeader id={id} segment="skills" />
      <ChipRow>
        <Chip
          label={`Installed ${skills.data ? installed.length : '–'}`}
          selected={tab === 'installed'}
          onPress={() => setTab('installed')}
        />
        <Chip
          label={`Proposed ${candidates.data ? proposed.length : '–'}`}
          selected={tab === 'proposed'}
          onPress={() => setTab('proposed')}
        />
      </ChipRow>
      {active.error ? (
        <Row
          wrap
          row={errorRow(active.error, tab === 'installed' ? 'skillsList' : 'skillCandidatesList')}
        />
      ) : null}
      {active.isPending ? <Skeleton rows={3} height={64} /> : null}

      {tab === 'installed' ? (
        <>
          {skills.data && installed.length === 0 ? (
            <Text style={[type.small, styles.pad]}>No skills installed.</Text>
          ) : null}
          {installed.map((s) => (
            <Pressable
              key={s.id}
              accessibilityRole="button"
              accessibilityState={{ expanded: open === s.id }}
              onPress={() => toggle(s.id)}
              style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
            >
              <Text style={type.body}>{s.name}</Text>
              <Text style={type.mono}>{s.id}</Text>
              {s.description ? <Text style={type.small}>{s.description}</Text> : null}
              {open === s.id ? <MarkdownView value={s.body} /> : null}
            </Pressable>
          ))}
        </>
      ) : (
        <>
          {candidates.data && proposed.length === 0 ? (
            <Text style={[type.small, styles.pad]}>No proposals.</Text>
          ) : null}
          {proposed.map((c) => {
            const v = candidateView(c.fileName, c.content);
            const expanded = open === c.fileName;
            return (
              <View key={c.fileName} style={styles.card}>
                <Text style={type.body}>{v.name}</Text>
                <Text style={type.mono}>{c.fileName}</Text>
                {v.description ? <Text style={type.small}>{v.description}</Text> : null}
                <Text style={[type.small, { color: color.warning }]}>⚠ proposed</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  onPress={() => toggle(c.fileName)}
                  hitSlop={8}
                  style={styles.review}
                >
                  <Text style={[type.body, { color: color.chrome }]}>
                    {expanded ? 'Hide review' : 'Review'}
                  </Text>
                </Pressable>
                {expanded ? (
                  <View>
                    <MarkdownView value={v.body} />
                    <Text style={[type.small, styles.web]}>Review on the web</Text>
                  </View>
                ) : null}
              </View>
            );
          })}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgBase },
  pad: { paddingHorizontal: 16, paddingVertical: 8 },
  card: {
    minHeight: 64,
    marginHorizontal: 16,
    marginVertical: 6,
    padding: 12,
    gap: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.borderSubtle,
    backgroundColor: color.bgElevated,
  },
  pressed: { backgroundColor: color.bgOverlay },
  review: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  web: { paddingTop: 8 },
});
