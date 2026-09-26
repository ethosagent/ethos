// archcheck-fixture: place-at extensions/tools-archcheck-fixture/src/index.ts
//
// Tool code reading configuration from process.env inside execute, where ctx is available.
export async function execute(): Promise<string> {
  return process.env.ARCHCHECK_FIXTURE_KEY ?? '';
}
