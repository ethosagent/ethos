import { Box, Text } from 'ink';
import { useSkin } from '../skin';

/** `owner`: the operator's own terminal sees every world. `shared`: a room others can read. */
export type WorldLane = 'owner' | 'shared';

export interface WorldChoice {
  slug: string;
  title: string;
  audience: 'owner_only' | 'shareable';
}

/**
 * What the host gives the TUI for `/world`. `tree` is the shared `renderTree` text (the same
 * string `ethos world show <slug> --tree` prints, built by apps/ethos/src/lib/world-tree-source.ts),
 * so the panel never formats a tree itself.
 */
export interface WorldTreeSource {
  lane: WorldLane;
  list(): Promise<WorldChoice[]>;
  tree(slug: string): Promise<string>;
}

/**
 * The worlds a lane may show: the owner lane every one, a shared lane only `shareable` ones, never
 * an `owner_only` world. Same rule as `resolveAccess` rule 3 (extensions/world-service/src/access.ts),
 * pinned here by __tests__/world-tree.test.ts 'shared lane shows only shareable worlds'.
 */
export function visibleWorlds(worlds: readonly WorldChoice[], lane: WorldLane): WorldChoice[] {
  return worlds.filter((w) => lane === 'owner' || w.audience === 'shareable');
}

interface WorldTreePanelProps {
  slug: string;
  title: string;
  /** The `renderTree` text, drawn line for line. */
  text: string;
}

export function WorldTreePanel({ slug, title, text }: WorldTreePanelProps) {
  const tokens = useSkin();
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={tokens.semantic.info}>
        world {slug}
        {title === slug ? '' : ` - ${title}`}
      </Text>
      {text.split('\n').map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable, ordered lines
        <Text key={i}>{line}</Text>
      ))}
      <Text dimColor>/world close hides this</Text>
    </Box>
  );
}
