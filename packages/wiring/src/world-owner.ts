// What the owner surfaces (apps/web-api `worlds.*`, plan world-model 7.2) take from the world
// service: the access resolver, the export and import codecs, and the error classes. apps may
// not import extensions (archcheck l5-apps-through-wiring), so they reach them here, as one
// namespace: `import { worldOwner } from '@ethosagent/wiring'`. Nothing here opens a store or a
// backend; the single runtime is `createWorldRuntime` (./worlds).

export type {
  AccessResult,
  MountsFile,
  WorldConfigService,
  WorldFile,
  WorldSchemaService,
  WorldService,
  WorldSnapshot,
} from '@ethosagent/world-service';
export {
  buildWorldSnapshot,
  describeBuildItem,
  exportCsv,
  exportFactsYaml,
  exportMcpJsonl,
  importCsv,
  importFactsYaml,
  importMcpJsonl,
  parseWorldId,
  resolveAccess,
  sliceBundle,
  toBundleJson,
  toGraphML,
  toMermaid,
  WorldConfigError,
  WorldServiceError,
  worldSlug,
} from '@ethosagent/world-service';
