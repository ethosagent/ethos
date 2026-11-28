import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { type ExploringNowSnapshot, readExploringNow } from '../exploring-now';
import { useSkin } from '../skin';

const POLL_MS = 5000;

/** Current window, cost so far, read-only label. Nothing when no window runs. */
export function ExploringNowStrip({ snapshot }: { snapshot: ExploringNowSnapshot | null }) {
  const tokens = useSkin();
  if (!snapshot) return null;
  return (
    <Box>
      <Text color={tokens.semantic.info}>● exploring now</Text>
      <Text color={tokens.surface.textSecondary}>
        {` ${snapshot.initiativeTitle} · window ${snapshot.windowId} · $${snapshot.costSoFarUsd.toFixed(2)} so far · `}
      </Text>
      <Text color={tokens.surface.textTertiary}>read-only</Text>
    </Box>
  );
}

/** The strip wired to the host-injected source, polled. Rendered by StatusBar. */
export function ExploringNowLine() {
  const [snapshot, setSnapshot] = useState<ExploringNowSnapshot | null>(() => readExploringNow());
  useEffect(() => {
    setSnapshot(readExploringNow());
    const timer = setInterval(() => setSnapshot(readExploringNow()), POLL_MS);
    return () => clearInterval(timer);
  }, []);
  return <ExploringNowStrip snapshot={snapshot} />;
}
