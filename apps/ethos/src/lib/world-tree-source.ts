// The one place a world's tree text is made for a terminal: `ethos world show --tree` and the TUI's
// `/world <slug>` both call `worldTreeText`, which is `renderTree` over the owner export, so the
// two never drift (apps/ethos/src/commands/__tests__/world-cli.test.ts 'show --tree prints the org
// chart', apps/tui/src/__tests__/world-tree.test.ts 'panel renders renderTree output').

import type { WorldId } from '@ethosagent/types';
import { type WorldRuntime, worldOwner } from '@ethosagent/wiring';

const { renderTree, sliceBundle } = worldOwner;

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
