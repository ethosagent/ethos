// The one place a world's tree text is made for a terminal: `ethos world show --tree` and the TUI's
// `/world <slug>` both call `worldTreeText`, which is `renderTree` over the owner export, so the
// two never drift (apps/ethos/src/commands/__tests__/world-cli.test.ts 'show --tree prints the org
// chart', apps/tui/src/__tests__/world-tree.test.ts 'panel renders renderTree output').

import type { WorldTreeSource } from '@ethosagent/tui';
import type { WorldId } from '@ethosagent/types';
import { type WorldRuntime, worldOwner } from '@ethosagent/wiring';

const { renderTree, sliceBundle } = worldOwner;

/** The TUI panel draws at most this many lines; `ethos world show --tree` is not capped. */
export const TUI_TREE_MAX_LINES = 40;

export async function worldTreeText(
  service: Pick<WorldRuntime['service'], 'ownerExport'>,
  world: WorldId,
  opts: { asOf?: string; entity?: string; maxLines?: number } = {},
): Promise<string> {
  const whole = await service.ownerExport(world);
  const bundle = sliceBundle(whole, opts.asOf === undefined ? {} : { asOf: opts.asOf });
  return renderTree(bundle, {
    ...(opts.entity === undefined ? {} : { entity: opts.entity }),
    ...(opts.maxLines === undefined ? {} : { maxLines: opts.maxLines }),
  });
}

/**
 * `/world` for the operator's own terminal: the `owner` lane, so every shared world is listed.
 * A lane that renders for other people would pass `shared`, and the TUI then lists only
 * `shareable` worlds (visibleWorlds, apps/tui/src/components/WorldTreePanel.tsx).
 */
export function createWorldTreeSource(
  current: () => Pick<WorldRuntime, 'service' | 'configService'> | undefined,
  lane: WorldTreeSource['lane'] = 'owner',
): WorldTreeSource {
  // `current` is read per call: a `/model` switch retires the loop (and closes its world runtime).
  const live = () => {
    const rt = current();
    if (!rt) throw new Error('the world model is not enabled');
    return rt;
  };
  return {
    lane,
    list: async () =>
      [...(await live().configService.listWorlds()).values()].map((w) => ({
        slug: w.id,
        title: w.title,
        audience: w.audience,
      })),
    tree: (slug) =>
      worldTreeText(live().service, `world:${slug}` as WorldId, { maxLines: TUI_TREE_MAX_LINES }),
  };
}
