// archcheck-fixture: place-at extensions/archcheck-fixture/src/computed-import.ts
//
// A dynamic import with a computed specifier resolves to nothing in the module graph, which is
// how a layer violation hides.
export async function reach(which: string): Promise<unknown> {
  return import(`./${which}`);
}
