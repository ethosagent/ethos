// Hosted "B" in the merge-order test: the in-process twin lives in hook-semantics.test.ts.
export function activate(api) {
  api.registerModifyingHook('before_prompt_build', async () => ({
    appendSystem: 'B',
    prependSystem: 'B-pre',
  }));
  api.registerModifyingHook('before_tool_call', async () => ({ args: { from: 'B' } }));
}
