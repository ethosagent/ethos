import { ORPCError } from '@orpc/server';
import { WorldsApiError } from '../services/worlds.service';
import { os } from './context';

// Worlds namespace — the owner's knowledge-graph surface (plan world-model 7.2). Thin by
// construction: each procedure calls one WorldsService method; every rule lives in WorldService,
// WorldSchemaService and WorldConfigService. Cookie-only: `worlds` is absent from SCOPE_MAP
// (middleware/dual-auth.ts), pinned by __tests__/routes/worlds-rpc.test.ts 'bearer key is refused'.

/** The plan's wire codes: NOT_FOUND 404, CONFLICT 409, INPUT_INVALID 400. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WorldsApiError) {
      switch (err.kind) {
        case 'not_found':
          throw new ORPCError('NOT_FOUND', { status: 404, message: err.message });
        case 'conflict':
          throw new ORPCError('CONFLICT', { status: 409, message: err.message });
        case 'invalid':
          throw new ORPCError('INPUT_INVALID', { status: 400, message: err.message });
      }
    }
    throw err;
  }
}

export const worldsRouter = {
  list: os.worlds.list.handler(({ context }) => run(() => context.worlds.list())),
  graph: os.worlds.graph.handler(({ input, context }) => run(() => context.worlds.graph(input))),
  tree: os.worlds.tree.handler(({ input, context }) => run(() => context.worlds.tree(input))),
  entity: os.worlds.entity.handler(({ input, context }) => run(() => context.worlds.entity(input))),
  changes: os.worlds.changes.handler(({ input, context }) =>
    run(() => context.worlds.changes(input)),
  ),
  proposals: os.worlds.proposals.handler(({ input, context }) =>
    run(() => context.worlds.proposals(input)),
  ),
  decide: os.worlds.decide.handler(({ input, context }) => run(() => context.worlds.decide(input))),
  factWrite: os.worlds.factWrite.handler(({ input, context }) =>
    run(() => context.worlds.factWrite(input)),
  ),
  factClose: os.worlds.factClose.handler(({ input, context }) =>
    run(() => context.worlds.factClose(input)),
  ),
  promote: os.worlds.promote.handler(({ input, context }) =>
    run(() => context.worlds.promote(input)),
  ),
  schema: os.worlds.schema.handler(({ input, context }) => run(() => context.worlds.schema(input))),
  schemaSave: os.worlds.schemaSave.handler(({ input, context }) =>
    run(() => context.worlds.schemaSave(input)),
  ),
  config: os.worlds.config.handler(({ input, context }) => run(() => context.worlds.config(input))),
  configSave: os.worlds.configSave.handler(({ input, context }) =>
    run(() => context.worlds.configSave(input)),
  ),
  mounts: os.worlds.mounts.handler(({ input, context }) => run(() => context.worlds.mounts(input))),
  mountsSave: os.worlds.mountsSave.handler(({ input, context }) =>
    run(() => context.worlds.mountsSave(input)),
  ),
  export: os.worlds.export.handler(({ input, context }) => run(() => context.worlds.export(input))),
  import: os.worlds.import.handler(({ input, context }) => run(() => context.worlds.import(input))),
  buildPreview: os.worlds.buildPreview.handler(({ input, context }) =>
    run(() => context.worlds.buildPreview(input)),
  ),
  shareCreate: os.worlds.shareCreate.handler(({ input, context }) =>
    run(() => context.worlds.shareCreate(input)),
  ),
  linkify: os.worlds.linkify.handler(({ input, context }) =>
    run(() => context.worlds.linkify(input)),
  ),
};
